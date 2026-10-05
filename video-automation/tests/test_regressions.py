"""Regression for the Objective-C SIGTRAP and the supervised one-extra-attempt quota override."""

import json
import os
import re
import shutil
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

import test_guards as guards

pipeline = guards.pipeline
ROOT = guards.ROOT
SLOT = "2026-10-04T09:00:00-07:00"
REASON = "Retry after fixing ObjC SIGTRAP in pixel buffer creation; supervised by operator"


def objc_code(name):
    """Source with // and /* */ comments removed, so only real code is inspected."""
    text = (ROOT / "src" / name).read_text(encoding="utf-8")
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"//[^\n]*", "", text)


class PixelBufferRegressionTests(unittest.TestCase):
    """DiagnosticReport: EXC_BREAKPOINT in CFGetTypeID <- _getCVPixelBufferPool <- CVPixelBufferPoolCreatePixelBuffer <- Render."""

    def test_render_no_longer_uses_the_adaptor_pool(self):
        code = objc_code("render_mp4.m")
        self.assertNotIn("CVPixelBufferPoolCreatePixelBuffer", code)
        self.assertNotIn("pixelBufferPool", code)
        self.assertNotIn("CVPixelBufferPoolRef", code)

    def test_render_creates_each_buffer_directly(self):
        code = objc_code("render_mp4.m")
        self.assertRegex(code, r"CVPixelBufferCreate\(\s*kCFAllocatorDefault")
        self.assertIn("kCVPixelFormatType_32BGRA", code)
        for key in ("kCVPixelBufferCGImageCompatibilityKey", "kCVPixelBufferCGBitmapContextCompatibilityKey",
                    "kCVPixelBufferIOSurfacePropertiesKey"):
            self.assertIn(key, code)

    def test_adaptor_is_kept_only_for_append(self):
        code = objc_code("render_mp4.m")
        uses = re.findall(r"\[adaptor\s+(\w+)", code) + re.findall(r"adaptor\.(\w+)", code)
        self.assertEqual(set(uses), {"appendPixelBuffer"})

    def test_every_cvreturn_and_lock_is_checked(self):
        code = objc_code("render_mp4.m")
        self.assertRegex(code, r"status = CVPixelBufferCreate\(")
        self.assertRegex(code, r"status = CVPixelBufferLockBaseAddress\(buffer, 0\);\s*if \(status != kCVReturnSuccess\)")
        self.assertRegex(code, r"status = CVPixelBufferUnlockBaseAddress\(buffer, 0\);")
        self.assertRegex(code, r"if \(status != kCVReturnSuccess\) \{\s*CVPixelBufferRelease\(buffer\);\s*Fail\(error, RenderError\(\[NSString stringWithFormat:@\"CVPixelBufferUnlockBaseAddress")
        # A short read releases the buffer and fails instead of encoding a partial frame.
        self.assertRegex(code, r"if \(!complete\) \{\s*CVPixelBufferRelease\(buffer\);")
        self.assertIn("CVPixelBufferGetPixelFormatType(buffer) != kCVPixelFormatType_32BGRA", code)

    def test_swift_renderer_also_avoids_the_pool(self):
        source = (ROOT / "src" / "render_mp4.swift").read_text(encoding="utf-8")
        self.assertNotIn("pixelBufferPool", source)
        self.assertIn("CVPixelBufferCreate(kCFAllocatorDefault", source)
        self.assertIn("CVPixelBufferLockBaseAddress(buffer, []) == kCVReturnSuccess", source)

    @unittest.skipUnless(shutil.which("clang"), "clang not installed")
    def test_objc_sources_parse_cleanly(self):
        """Syntax/ARC check with clang against the real SDK on macOS (not run in cloud without an SDK)."""
        if sys.platform != "darwin":
            self.skipTest("Apple SDK headers only exist on macOS; cloud runs use a stub-header check instead")
        for name in ("render_mp4.m", "inspect_mp4.m"):
            result = subprocess.run(
                ["xcrun", "--sdk", "macosx", "clang", "-fsyntax-only", "-x", "objective-c", "-fobjc-arc", "-fno-modules",
                 "-Wall", "-Werror=implicit-function-declaration", str(ROOT / "src" / name)],
                capture_output=True, text=True, timeout=120, stdin=subprocess.DEVNULL,
            )
            self.assertEqual(result.returncode, 0, result.stderr)


class QuotaOverrideTests(guards.OfflineCase):
    def spend_normal_quota(self):
        for _ in range(int(self.runtime["limits"]["max_render_attempts_per_day"])):
            pipeline.append_ledger(self.runtime, {"event": "started", "draft_id": "x", "at": self.now().isoformat()})
            pipeline.append_ledger(self.runtime, {"event": "failed", "draft_id": "x", "at": self.now().isoformat()})

    def test_default_stays_closed_when_exhausted(self):
        self.spend_normal_quota()
        with self.assertRaisesRegex(pipeline.PolicyError, "attempt quota"):
            pipeline.enforce_render_quota(self.runtime, self.now())

    def test_override_refused_while_normal_quota_remains(self):
        with self.assertRaisesRegex(pipeline.PolicyError, "not exhausted"):
            pipeline.enforce_render_quota(self.runtime, self.now(), REASON)

    def test_override_grants_one_attempt_after_exhaustion(self):
        self.spend_normal_quota()
        status = pipeline.enforce_render_quota(self.runtime, self.now(), REASON)
        self.assertTrue(status["override"])

    def test_only_one_override_per_day(self):
        self.spend_normal_quota()
        pipeline.append_ledger(self.runtime, {"event": "quota_override", "draft_id": "x", "at": self.now().isoformat(), "reason": REASON})
        with self.assertRaisesRegex(pipeline.PolicyError, "already used"):
            pipeline.enforce_render_quota(self.runtime, self.now(), "another reason")

    def test_yesterdays_override_does_not_count(self):
        self.spend_normal_quota()
        yesterday = self.now() - pipeline.timedelta(days=1, hours=1)
        pipeline.append_ledger(self.runtime, {"event": "quota_override", "draft_id": "x", "at": yesterday.isoformat(), "reason": REASON})
        self.assertTrue(pipeline.enforce_render_quota(self.runtime, self.now(), REASON)["override"])

    def test_blank_or_huge_reasons_are_rejected(self):
        for reason in ("", "   ", "\n\t"):
            with self.subTest(repr(reason)), self.assertRaisesRegex(pipeline.PolicyError, "non-empty"):
                pipeline.validate_override_reason(reason)
        with self.assertRaisesRegex(pipeline.PolicyError, "at most"):
            pipeline.validate_override_reason("x" * 501)
        self.assertEqual(pipeline.validate_override_reason("  fix \n retry  "), "fix retry")

    def test_override_only_with_supervised_render_pilot(self):
        for command, supervised in (("render-pilot", False), ("dry-run", True), ("hourly", True), ("healthcheck", True)):
            with self.subTest(command=command, supervised=supervised):
                with self.assertRaisesRegex(pipeline.PolicyError, "only accepted with render-pilot --supervised"):
                    pipeline.run(command, SLOT, supervised=supervised, override_reason=REASON)

    def fake_render(self, *args, **kwargs):
        return {"rendered_at": self.now().isoformat(), "provider_cost": 0, "backend": "objc"}

    def run_pilot(self, reason=None):
        with mock.patch.object(pipeline, "resolve_toolchain", return_value=object()), \
             mock.patch.object(pipeline, "check_card_dependencies", return_value="ok"), \
             mock.patch.object(pipeline, "build_renderers", return_value={"backend": "objc"}), \
             mock.patch.object(pipeline, "render_video", side_effect=self.fake_render):
            return pipeline.run("render-pilot", SLOT, supervised=True, override_reason=reason)

    def test_override_is_recorded_with_reason_and_cannot_repeat(self):
        self.spend_normal_quota()
        with self.assertRaisesRegex(pipeline.PolicyError, "attempt quota"):
            self.run_pilot()
        result = self.run_pilot(REASON)
        self.assertEqual(result["status"], "qa_pending")
        ledger = pipeline.read_ledger(self.runtime)
        overrides = [e for e in ledger if e["event"] == "quota_override"]
        self.assertEqual(len(overrides), 1)
        self.assertEqual(overrides[0]["reason"], REASON)
        self.assertTrue(overrides[0]["supervised"])
        self.assertEqual(overrides[0]["usage"], {"attempts": 2, "completed": 0})
        started = [e for e in ledger if e["event"] == "started"]
        self.assertTrue(started[-1]["quota_override"])
        # A different slot (new draft) cannot get a second override today.
        with mock.patch.object(pipeline, "resolve_toolchain", return_value=object()), \
             mock.patch.object(pipeline, "check_card_dependencies", return_value="ok"), \
             mock.patch.object(pipeline, "build_renderers", return_value={"backend": "objc"}), \
             mock.patch.object(pipeline, "render_video", side_effect=self.fake_render):
            with self.assertRaisesRegex(pipeline.PolicyError, "quota"):
                pipeline.run("render-pilot", "2026-10-04T10:00:00-07:00", supervised=True, override_reason=REASON)

    def test_failed_override_attempt_is_still_consumed(self):
        self.spend_normal_quota()
        with mock.patch.object(pipeline, "resolve_toolchain", return_value=object()), \
             mock.patch.object(pipeline, "check_card_dependencies", return_value="ok"), \
             mock.patch.object(pipeline, "build_renderers", return_value={"backend": "objc"}), \
             mock.patch.object(pipeline, "render_video", side_effect=pipeline.PolicyError("render failed")):
            with self.assertRaisesRegex(pipeline.PolicyError, "render failed"):
                pipeline.run("render-pilot", SLOT, supervised=True, override_reason=REASON)
        self.assertEqual(pipeline.overrides_used_today(self.runtime, self.now()), 1)
        with self.assertRaisesRegex(pipeline.PolicyError, "already used"):
            pipeline.enforce_render_quota(self.runtime, self.now(), REASON)

    def test_healthcheck_reports_override_availability(self):
        self.spend_normal_quota()
        report = pipeline.healthcheck(self.runtime, self.brand, toolchain_resolver=lambda: None)
        quota = next(c for c in report["checks"] if c["name"] == "quota")
        self.assertTrue(quota["ok"])
        self.assertTrue(quota["detail"]["override_available"])
        pipeline.append_ledger(self.runtime, {"event": "quota_override", "draft_id": "x", "at": self.now().isoformat(), "reason": REASON})
        report = pipeline.healthcheck(self.runtime, self.brand, toolchain_resolver=lambda: None)
        quota = next(c for c in report["checks"] if c["name"] == "quota")
        self.assertFalse(quota["ok"])

    def test_cli_rejects_blank_reason(self):
        result = subprocess.run(
            [sys.executable, str(ROOT / "src" / "pipeline.py"), "render-pilot", "--supervised", "--slot", SLOT,
             "--quota-override-reason", "   "],
            capture_output=True, text=True, timeout=30, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("non-empty", json.loads(result.stderr)["error"])


if __name__ == "__main__":
    unittest.main()
