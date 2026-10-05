"""Reversible SwiftBridging fix (project-local VFS overlay), backend pinning, frame streaming and preflight."""

import hashlib
import json
import os
import subprocess
import sys
import textwrap
import unittest
from pathlib import Path
from unittest import mock

import test_guards as guards
import test_fallback as fallback

pipeline = guards.pipeline

try:
    import PIL  # noqa: F401
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

MODULE_MAP = textwrap.dedent("""\
    module SwiftShims {
      header "shims.h"
      export *
    }
    module SwiftBridging {
      header "bridging.h"
      explicit module Nested { header "nested.h" }
      export *
    }
""")
BRIDGING_MAP = textwrap.dedent("""\
    module SwiftBridging {
      header "swift/bridging"
      export *
    }
""")


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class OverlayTests(guards.OfflineCase):
    def setUp(self):
        super().setUp()
        self.dev = self.root / "CommandLineTools"
        include = self.dev / "usr" / "include" / "swift"
        include.mkdir(parents=True)
        self.redefining = include / "module.modulemap"
        self.winner = include / "bridging.modulemap"
        self.redefining.write_text(MODULE_MAP)
        self.winner.write_text(BRIDGING_MAP)
        self.before = {p: digest(p) for p in (self.redefining, self.winner)}
        patcher = mock.patch.object(pipeline, "APPLE_DEVELOPER_ROOTS", (str(self.dev) + "/",))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.error = "\n".join([
            f"{self.redefining}:4:8: error: redefinition of module 'SwiftBridging'",
            "module SwiftBridging {",
            "       ^",
            f"{self.winner}:1:8: note: previously defined here",
            "<unknown>:0: error: could not build C module 'SwiftShims'",
        ])

    def tearDown(self):
        for path, value in self.before.items():
            self.assertEqual(digest(path), value, f"system file {path} must never change")
        super().tearDown()

    def test_overlay_shadows_only_the_duplicate_block(self):
        overlay = pipeline.swiftbridging_overlay(self.error, fallback.toolchain(), self.root / ".build")
        self.assertIsNotNone(overlay)
        self.assertEqual([h["path"] for h in overlay["hidden"]], [str(self.redefining)])
        replacement = Path(overlay["hidden"][0]["replacement"])
        self.assertIn(self.root / ".build" / "vfs", replacement.parents)
        text = replacement.read_text()
        self.assertNotIn("module SwiftBridging", text)
        self.assertNotIn("Nested", text)
        self.assertIn("module SwiftShims", text)
        data = json.loads(Path(overlay["path"]).read_text())
        self.assertEqual(data["roots"][0]["name"], str(self.redefining.parent))
        self.assertEqual(data["roots"][0]["contents"][0], {
            "type": "file", "name": "module.modulemap", "external-contents": str(replacement),
        })
        self.assertEqual(overlay["flags"][:2], ["-vfsoverlay", overlay["path"]])
        self.assertEqual(overlay["flags"][2:], ["-Xcc", "-ivfsoverlay", "-Xcc", overlay["path"]])
        self.assertEqual(Path(overlay["path"]).stat().st_mode & 0o777, 0o600)

    def test_overlay_is_reversible_and_can_be_disabled(self):
        overlay = pipeline.swiftbridging_overlay(self.error, fallback.toolchain(), self.root / ".build")
        vfs = Path(overlay["path"]).parent
        self.assertTrue(vfs.exists())
        with mock.patch.dict(os.environ, {pipeline.VFS_ENV: "0"}):
            self.assertIsNone(pipeline.swiftbridging_overlay(self.error, fallback.toolchain(), self.root / ".build"))

    def test_never_touches_files_outside_apple_developer_roots(self):
        with mock.patch.object(pipeline, "APPLE_DEVELOPER_ROOTS", ("/Library/Developer/CommandLineTools/",)):
            self.assertIsNone(pipeline.swiftbridging_overlay(self.error, fallback.toolchain(), self.root / ".build"))

    def test_never_hides_the_winning_definition(self):
        error = f"{self.winner}:1:8: error: redefinition of module 'SwiftBridging'\n{self.winner}:1:8: note: previously defined here"
        self.assertIsNone(pipeline.swiftbridging_overlay(error, fallback.toolchain(), self.root / ".build"))

    def test_other_modules_are_not_overlaid(self):
        error = self.error.replace("'SwiftBridging'", "'Foundation'")
        self.assertIsNone(pipeline.swiftbridging_overlay(error, fallback.toolchain(), self.root / ".build"))

    def test_strip_module_handles_nesting(self):
        self.assertEqual(pipeline.strip_module("a\nmodule X { b { c } }\nz", "X"), "a\n\nz")
        with self.assertRaises(pipeline.ToolchainError):
            pipeline.strip_module("module X { open", "X")


class OverlayBuildTests(OverlayTests):
    def compilers(self, retry_fails=False):
        error = self.error

        class Runner(fallback.Compilers):
            def __call__(inner, command, timeout, env=None):
                if command[3] == "swiftc" and ("-vfsoverlay" not in command or retry_fails):
                    inner.calls.append(command)
                    return subprocess.CompletedProcess(command, 1, "", error)
                return fallback.Compilers.__call__(inner, command, timeout, env)

        return Runner()

    def build(self, runner, backend=None):
        logs = []
        built = pipeline.build_renderers(fallback.toolchain(), logs, self.root / "var" / "state" / "logs", runner, backend)
        return built, logs

    def test_swift_first_then_swift_with_overlay(self):
        runner = self.compilers()
        built, logs = self.build(runner)
        self.assertEqual(built["backend"], "swift-vfs")
        self.assertEqual(built["render"].name, "render_mp4-vfs")
        self.assertEqual(built["inspect"].name, "inspect_mp4-vfs")
        self.assertIn("SwiftBridging", built["fallback_reason"])
        self.assertEqual(runner.by("clang"), [])
        retried = [c for c in runner.by("swiftc") if "-vfsoverlay" in c]
        self.assertEqual(len(retried), 2)
        self.assertIn({"step": "swift:vfs-overlay", "overlay": built["overlay"]["path"], "hidden": built["overlay"]["hidden"]}, logs)

    def test_overlay_still_failing_falls_back_to_objc(self):
        runner = self.compilers(retry_fails=True)
        built, _ = self.build(runner)
        self.assertEqual(built["backend"], "objc")
        self.assertIn("still after VFS overlay", built["fallback_reason"])

    def test_disabled_overlay_goes_to_objc(self):
        with mock.patch.dict(os.environ, {pipeline.VFS_ENV: "off"}):
            built, _ = self.build(self.compilers())
        self.assertEqual(built["backend"], "objc")


class BackendPinTests(guards.OfflineCase):
    def test_objc_can_be_pinned_by_the_operator(self):
        runner = fallback.Compilers()
        with mock.patch.dict(os.environ, {pipeline.BACKEND_ENV: "objc"}):
            built = pipeline.build_renderers(fallback.toolchain(), [], self.root / "logs", runner)
        self.assertEqual(built["backend"], "objc")
        self.assertEqual(runner.by("swiftc"), [])

    def test_pinned_swift_never_falls_back(self):
        runner = fallback.Compilers(swift={"render_mp4.swift": fallback.SWIFT_BRIDGING_FAILURE})
        with self.assertRaisesRegex(pipeline.ToolchainError, "=swift but Swift is unusable"):
            pipeline.build_renderers(fallback.toolchain(), [], self.root / "logs", runner, "swift")
        self.assertEqual(runner.by("clang"), [])

    def test_invalid_backend_value(self):
        with mock.patch.dict(os.environ, {pipeline.BACKEND_ENV: "ffmpeg"}):
            with self.assertRaisesRegex(pipeline.PolicyError, "auto, swift or objc"):
                pipeline.requested_backend()


ENCODER = textwrap.dedent("""\
    import json, sys, time
    out, w, h, fps, frames, mode = sys.argv[1:7]
    if mode == "sleep":
        time.sleep(30)
    if mode == "early":
        sys.stdin.buffer.read(10)
        sys.stderr.write("render error: simulated early exit\\n")
        sys.exit(1)
    need = int(w) * int(h) * 4 * int(frames)
    data = sys.stdin.buffer.read()
    if len(data) != need:
        sys.stderr.write(f"render error: got {len(data)} bytes, need {need}\\n")
        sys.exit(1)
    open(out, "wb").write(b"mp4")
    print(json.dumps({"status": "ok", "frames": int(frames)}))
""")


class StreamFramesTests(guards.OfflineCase):
    def run_encoder(self, mode, frames=3, timeout=30):
        script = self.root / "encoder.py"
        script.write_text(ENCODER)
        out = self.root / "out.mp4"
        command = [sys.executable, str(script), str(out), "4", "2", "30", str(frames), mode]
        chunks = (bytes([i % 256]) * (4 * 2 * 4) for i in range(frames))
        logs = []
        result = pipeline.stream_frames(command, chunks, timeout, "render", self.root / "logs", logs)
        return result, logs, out

    def test_streams_exact_bytes_and_logs(self):
        result, logs, out = self.run_encoder("ok")
        self.assertEqual(json.loads(result.stdout)["frames"], 3)
        self.assertEqual(out.read_bytes(), b"mp4")
        self.assertEqual(logs[0]["frames_sent"], 3)
        self.assertEqual(Path(logs[0]["log"]).stat().st_mode & 0o777, 0o600)

    def test_encoder_failure_is_reported_with_diagnostics(self):
        with self.assertRaisesRegex(pipeline.PolicyError, "simulated early exit|got .* bytes"):
            self.run_encoder("early", frames=2000)

    def test_watchdog_kills_a_hung_encoder(self):
        with self.assertRaisesRegex(pipeline.PolicyError, "render failed"):
            self.run_encoder("sleep", frames=1, timeout=1)


class PreQuotaBuildTests(guards.OfflineCase):
    def test_compiler_failure_never_spends_quota(self):
        with mock.patch.object(pipeline, "resolve_toolchain", return_value=fallback.toolchain()), \
             mock.patch.object(pipeline, "check_card_dependencies", return_value="ok"), \
             mock.patch.object(pipeline, "build_renderers", side_effect=pipeline.ToolchainError("swiftc broke")):
            with self.assertRaisesRegex(pipeline.ToolchainError, "swiftc broke"):
                pipeline.run("render-pilot", "2026-10-05T10:00:00-07:00", supervised=True)
        self.assertEqual(pipeline.read_ledger(self.runtime), [])
        self.assertEqual(list((self.root / "var" / "review").iterdir()), [])


@unittest.skipUnless(HAS_PIL, "Pillow is required for the preflight frame QA")
class PreflightTests(guards.OfflineCase):
    def test_preflight_renders_nothing_and_spends_nothing(self):
        built = {"backend": "objc", "render": Path("r"), "inspect": Path("i"), "fallback_reason": "test", "overlay": None}
        with mock.patch.object(pipeline, "resolve_toolchain", return_value=fallback.toolchain()), \
             mock.patch.object(pipeline, "build_renderers", return_value=built):
            report = pipeline.run("preflight", "2026-10-05T10:00:00-07:00")
        self.assertEqual(report["status"], "preflight_ok")
        self.assertFalse(report["rendered"])
        self.assertTrue(18 <= report["duration_seconds"] <= 24)
        self.assertLess(report["hook_lands_at"], 0.5)
        sheet = Path(report["qa"]["contact_sheet"]["path"])
        self.assertIn(self.root / "var" / "state" / "preflight", sheet.parents)
        self.assertGreaterEqual(len(report["qa"]["contact_sheet"]["moments"]), 8)
        self.assertGreater(report["qa"]["empty_frame_checks"], 40)
        self.assertEqual(pipeline.read_ledger(self.runtime), [])
        self.assertEqual(list((self.root / "var" / "drafts").iterdir()), [])
        self.assertEqual(list((self.root / "var" / "review").iterdir()), [])
        self.assertFalse(report["meta"]["connected"])


if __name__ == "__main__":
    unittest.main()
