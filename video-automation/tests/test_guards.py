"""Fail-closed guards: toolchain, healthcheck, kill switch, quota/retention, lock, Meta adapter.

Every test runs offline: sockets are sabotaged where a code path could plausibly
reach the network, and storage is redirected to a temporary root.
"""

import ast
import importlib.util
import json
import os
import socket
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
if "pipeline" in sys.modules:
    pipeline = sys.modules["pipeline"]
else:
    SPEC = importlib.util.spec_from_file_location("pipeline", ROOT / "src" / "pipeline.py")
    pipeline = importlib.util.module_from_spec(SPEC)
    sys.modules[SPEC.name] = pipeline
    SPEC.loader.exec_module(pipeline)
import meta_adapter  # noqa: E402  (src/ is placed on sys.path by pipeline)

TZ = ZoneInfo("America/Los_Angeles")
NETWORK_MODULES = {"socket", "ssl", "http", "urllib", "requests", "httpx", "aiohttp", "ftplib", "smtplib"}


def no_network(*_args, **_kwargs):
    raise AssertionError("network access attempted")


class OfflineCase(unittest.TestCase):
    """Temp storage root + sabotaged sockets for every test."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        for name in ("drafts", "review", "state"):
            (self.root / "var" / name).mkdir(parents=True)
        self.runtime = pipeline.load_json(ROOT / "config" / "runtime.json")
        self.brand = pipeline.load_json(ROOT / "config" / "brand.json")
        self.topics = pipeline.load_json(ROOT / "config" / "topics.json")
        patches = [
            mock.patch.object(pipeline, "ROOT", self.root),
            mock.patch.object(socket, "socket", no_network),
            mock.patch.object(socket, "create_connection", no_network),
            mock.patch.object(socket, "getaddrinfo", no_network),
            mock.patch.dict(os.environ, {pipeline.KILL_ENV: ""}),
        ]
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(self.temp.cleanup)

    def now(self):
        return datetime.now(TZ)


def fake_runner(responses):
    """Return a runner that answers by matching a substring of the joined command."""
    calls = []

    def run(command, timeout, env=None):
        calls.append({"command": command, "timeout": timeout, "env": env})
        joined = " ".join(command)
        for needle, (code, out, err) in responses.items():
            if needle in joined:
                return subprocess.CompletedProcess(command, code, out, err)
        return subprocess.CompletedProcess(command, 0, "", "")

    run.calls = calls
    return run


class ToolchainTests(OfflineCase):
    def happy_responses(self, sdk):
        return {
            "xcode-select -p": (0, "/Applications/Xcode.app/Contents/Developer\n", ""),
            "--find swiftc": (0, "/fake/swiftc\n", ""),
            "--show-sdk-path": (0, f"{sdk}\n", ""),
            "--show-sdk-version": (0, "15.0\n", ""),
            "swiftc --version": (0, "swift-driver version: 1.115 Apple Swift version 6.0\n", ""),
        }

    def test_non_macos_host_is_blocked(self):
        with self.assertRaisesRegex(pipeline.ToolchainError, "requires macOS"):
            pipeline.resolve_toolchain(platform_name="linux")

    def test_this_cloud_host_cannot_render(self):
        if sys.platform == "darwin":
            self.skipTest("only meaningful off macOS")
        with self.assertRaises(pipeline.ToolchainError):
            pipeline.resolve_toolchain()

    def test_missing_xcrun_is_blocked(self):
        with self.assertRaisesRegex(pipeline.ToolchainError, "missing"):
            pipeline.resolve_toolchain(platform_name="darwin", machine="arm64", exists=lambda path: False)

    def test_unsupported_arch_is_blocked(self):
        with self.assertRaisesRegex(pipeline.ToolchainError, "architecture"):
            pipeline.resolve_toolchain(platform_name="darwin", machine="ppc", exists=lambda path: True)

    def test_resolves_swiftc_and_sdk_through_xcrun(self):
        runner = fake_runner(self.happy_responses(self.temp.name))
        tc = pipeline.resolve_toolchain(platform_name="darwin", machine="arm64", runner=runner, exists=lambda path: True)
        self.assertEqual(tc.swiftc, "/fake/swiftc")
        self.assertEqual(tc.sdk_path, self.temp.name)
        self.assertEqual(tc.target, "arm64-apple-macos13.0")
        xcrun_calls = [c["command"] for c in runner.calls if c["command"][0] == pipeline.XCRUN]
        self.assertTrue(xcrun_calls)
        for command in xcrun_calls:
            self.assertEqual(command[1:3], ["--sdk", "macosx"])

    def test_license_prompt_stops_for_a_human(self):
        responses = self.happy_responses(self.temp.name)
        responses["--find swiftc"] = (69, "", "You have not agreed to the Xcode license agreements.")
        runner = fake_runner(responses)
        with self.assertRaisesRegex(pipeline.ToolchainError, "Blocked: the Xcode license"):
            pipeline.resolve_toolchain(platform_name="darwin", machine="arm64", runner=runner, exists=lambda path: True)

    def test_missing_command_line_tools_never_triggers_install(self):
        responses = self.happy_responses(self.temp.name)
        responses["xcode-select -p"] = (2, "", "xcode-select: error: unable to get active developer directory, use `xcode-select --install`")
        runner = fake_runner(responses)
        with self.assertRaisesRegex(pipeline.ToolchainError, "Command Line Tools"):
            pipeline.resolve_toolchain(platform_name="darwin", machine="arm64", runner=runner, exists=lambda path: True)
        self.assertFalse(any("--install" in c["command"] for c in runner.calls))

    def test_nonexistent_sdk_is_rejected(self):
        responses = self.happy_responses(str(self.root / "missing-sdk"))
        runner = fake_runner(responses)
        with self.assertRaisesRegex(pipeline.ToolchainError, "SDK path"):
            pipeline.resolve_toolchain(platform_name="darwin", machine="arm64", runner=runner, exists=lambda path: True)

    def toolchain(self):
        return pipeline.Toolchain(
            xcrun=pipeline.XCRUN, swiftc="/fake/swiftc", sdk_path="/fake/sdk",
            sdk_version="15.0", target="arm64-apple-macos13.0", swiftc_version="Apple Swift version 6.0",
        )

    def test_swiftc_command_is_portable(self):
        cache = self.root / "cache"
        command = pipeline.swiftc_command(self.toolchain(), Path("a.swift"), Path("a"), cache)
        self.assertEqual(command[:4], [pipeline.XCRUN, "--sdk", "macosx", "swiftc"])
        self.assertNotIn("/usr/bin/swiftc", command)
        for flag, value in (("-sdk", "/fake/sdk"), ("-target", "arm64-apple-macos13.0"),
                            ("-swift-version", "5"), ("-module-cache-path", str(cache))):
            self.assertEqual(command[command.index(flag) + 1], value)

    def test_swift_env_uses_private_module_cache(self):
        with mock.patch.dict(os.environ, {"SWIFT_EXEC": "/evil", "CLANG_MODULE_CACHE_PATH": "/shared"}):
            env = pipeline.swift_env(self.root / "cache")
        self.assertEqual(env["CLANG_MODULE_CACHE_PATH"], str(self.root / "cache"))
        self.assertNotIn("SWIFT_EXEC", env)

    def test_compile_failure_keeps_full_diagnostics(self):
        source = self.root / "x.swift"
        source.write_text("let x = 1\n")
        stale = self.root / ".build" / "module-cache" / "x" / "stale.pcm"
        stale.parent.mkdir(parents=True)
        stale.write_text("stale")
        long_stderr = "\n".join(f"error line {i}" for i in range(200))
        seen_cache_state = {}

        def runner(command, timeout, env=None):
            seen_cache_state["stale_present"] = stale.exists()
            seen_cache_state["env_cache"] = env["CLANG_MODULE_CACHE_PATH"]
            return subprocess.CompletedProcess(command, 1, "", long_stderr)

        logs = []
        log_dir = self.root / "var" / "state" / "logs"
        with self.assertRaises(pipeline.ToolchainError) as ctx:
            pipeline.compile_swift(self.toolchain(), "x", source, logs, log_dir, runner)
        self.assertFalse(seen_cache_state["stale_present"], "module cache must be wiped before building")
        self.assertEqual(seen_cache_state["env_cache"], str(stale.parent))
        self.assertIn("full diagnostics", str(ctx.exception))
        log_path = Path(logs[0]["log"])
        content = log_path.read_text()
        self.assertIn("error line 0", content)
        self.assertIn("error line 199", content)
        self.assertIn("-module-cache-path", content)
        self.assertEqual(log_path.stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.root / ".build" / "x").exists())

    def test_compile_success_is_cached_by_source_and_toolchain(self):
        source = self.root / "x.swift"
        source.write_text("let x = 1\n")

        def runner(command, timeout, env=None):
            Path(command[command.index("-o") + 1]).write_text("binary")
            return subprocess.CompletedProcess(command, 0, "", "")

        counting = mock.Mock(side_effect=runner)
        log_dir = self.root / "var" / "state" / "logs"
        binary = pipeline.compile_swift(self.toolchain(), "x", source, [], log_dir, counting)
        self.assertEqual(binary.stat().st_mode & 0o777, 0o700)
        pipeline.compile_swift(self.toolchain(), "x", source, [], log_dir, counting)
        self.assertEqual(counting.call_count, 1)
        source.write_text("let x = 2\n")
        pipeline.compile_swift(self.toolchain(), "x", source, [], log_dir, counting)
        self.assertEqual(counting.call_count, 2)

    def test_swift_sources_are_headless(self):
        for name in ("render_mp4.swift", "inspect_mp4.swift"):
            source = (ROOT / "src" / name).read_text()
            self.assertNotIn("import AppKit", source)
            self.assertNotIn("NSImage", source)
        self.assertIn("import ImageIO", (ROOT / "src" / "render_mp4.swift").read_text())
        self.assertIn("shouldOptimizeForNetworkUse = true", (ROOT / "src" / "render_mp4.swift").read_text())
        self.assertIn("decodable", (ROOT / "src" / "inspect_mp4.swift").read_text())

    def test_subprocesses_cannot_wait_on_stdin(self):
        with mock.patch.object(subprocess, "run") as run:
            pipeline.run_diag(["true"], 5)
        self.assertIs(run.call_args.kwargs["stdin"], subprocess.DEVNULL)


class KillSwitchTests(OfflineCase):
    def test_env_kill_switch(self):
        with mock.patch.dict(os.environ, {pipeline.KILL_ENV: "1"}):
            with self.assertRaisesRegex(pipeline.PolicyError, "Kill switch"):
                pipeline.ensure_not_killed(self.runtime)

    def test_file_kill_switch(self):
        (self.root / "var" / "state" / "KILL").write_text("")
        with self.assertRaisesRegex(pipeline.PolicyError, "kill file"):
            pipeline.ensure_not_killed(self.runtime)

    def test_disengaged_by_default(self):
        self.assertIsNone(pipeline.kill_switch_reason(self.runtime))

    def test_render_pilot_honours_kill_switch_before_anything(self):
        with mock.patch.dict(os.environ, {pipeline.KILL_ENV: "true"}):
            with self.assertRaisesRegex(pipeline.PolicyError, "Kill switch"):
                pipeline.run("render-pilot", "2026-10-04T09:00:00-07:00", supervised=True)
        self.assertEqual(list((self.root / "var" / "review").iterdir()), [])

    def run_hourly_script(self, extra_env):
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "CALI_CLEAN_PYTHON": "/nonexistent/python", **extra_env}
        return subprocess.run(["sh", str(ROOT / "scripts" / "run-hourly")], env=env, capture_output=True, text=True, timeout=10)

    def test_hourly_script_disabled_by_default(self):
        self.assertEqual(self.run_hourly_script({}).returncode, 78)

    def test_hourly_script_honours_kill_switch_even_when_enabled(self):
        result = self.run_hourly_script({"VIDEO_ROUTINE_ENABLED": "true", "CALI_CLEAN_VIDEO_KILL": "YES"})
        self.assertEqual(result.returncode, 78)
        self.assertIn("kill switch", result.stderr)


class EntryPointTests(OfflineCase):
    SLOT = "2026-10-04T09:00:00-07:00"

    def test_render_pilot_requires_supervision(self):
        with self.assertRaisesRegex(pipeline.PolicyError, "--supervised"):
            pipeline.run("render-pilot", self.SLOT)

    def test_hourly_stays_disabled(self):
        with self.assertRaisesRegex(pipeline.PolicyError, "disabled"):
            pipeline.run("hourly", self.SLOT)

    def test_dry_run_is_offline_and_idempotent(self):
        first = pipeline.run("dry-run", self.SLOT)
        self.assertEqual(first["status"], "dry_run")
        self.assertIsNone(first["video"])
        self.assertFalse(first["meta"]["connected"])
        manifest = Path(first["manifest"])
        self.assertEqual(manifest.stat().st_mode & 0o777, 0o600)
        second = pipeline.run("dry-run", self.SLOT)
        self.assertEqual(second["status"], "idempotent_existing")
        self.assertEqual(len(list((self.root / "var" / "review").glob("*.json"))), 1)

    @unittest.skipIf(sys.platform == "darwin", "exercises the non-macOS fail-closed path")
    def test_render_after_dry_run_reaches_toolchain_and_fails_closed(self):
        pipeline.run("dry-run", self.SLOT)
        with self.assertRaises(pipeline.ToolchainError):
            pipeline.run("render-pilot", self.SLOT, supervised=True)
        # Nothing was started, so no quota was consumed and no draft media exists.
        self.assertEqual(pipeline.read_ledger(self.runtime), [])
        self.assertEqual(list((self.root / "var" / "drafts").iterdir()), [])

    def test_cli_reports_blocked_without_traceback(self):
        result = subprocess.run(
            [sys.executable, str(ROOT / "src" / "pipeline.py"), "render-pilot", "--slot", self.SLOT],
            capture_output=True, text=True, timeout=30,
            env={**os.environ, pipeline.KILL_ENV: "1", "PYTHONDONTWRITEBYTECODE": "1"},
        )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stderr)["status"], "blocked")


class LockTests(OfflineCase):
    def test_second_holder_is_refused(self):
        with pipeline.exclusive_lock(self.runtime) as path:
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaisesRegex(pipeline.PolicyError, "lock"):
                with pipeline.exclusive_lock(self.runtime):
                    pass
            self.assertFalse(pipeline.lock_is_free(self.runtime))
        self.assertTrue(pipeline.lock_is_free(self.runtime))

    def test_run_is_refused_while_locked(self):
        with pipeline.exclusive_lock(self.runtime):
            with self.assertRaisesRegex(pipeline.PolicyError, "lock"):
                pipeline.run("dry-run", "2026-10-04T09:00:00-07:00")


class QuotaTests(OfflineCase):
    def record(self, event, when):
        pipeline.append_ledger(self.runtime, {"event": event, "draft_id": "x", "at": when.isoformat()})

    def test_one_completed_render_exhausts_the_day(self):
        self.record("started", self.now())
        self.record("completed", self.now())
        with self.assertRaisesRegex(pipeline.PolicyError, "quota"):
            pipeline.enforce_render_quota(self.runtime, self.now())

    def test_failed_attempts_are_bounded(self):
        for _ in range(int(self.runtime["limits"]["max_render_attempts_per_day"])):
            self.record("started", self.now())
            self.record("failed", self.now())
        with self.assertRaisesRegex(pipeline.PolicyError, "attempt quota"):
            pipeline.enforce_render_quota(self.runtime, self.now())

    def test_yesterday_does_not_count(self):
        yesterday = self.now() - timedelta(days=1, hours=1)
        self.record("started", yesterday)
        self.record("completed", yesterday)
        status = pipeline.enforce_render_quota(self.runtime, self.now())
        self.assertEqual((status["attempts"], status["completed"], status["override"]), (0, 0, False))

    def test_quota_uses_wall_clock_not_slot(self):
        manifest = {"slot": "2020-01-01T09:00:00-08:00", "render": {"rendered_at": self.now().isoformat()}}
        pipeline.write_json_private(self.root / "var" / "review" / "old-slot.json", manifest)
        with self.assertRaisesRegex(pipeline.PolicyError, "quota"):
            pipeline.enforce_render_quota(self.runtime, self.now())

    def test_corrupt_ledger_fails_closed(self):
        (self.root / "var" / "state" / pipeline.LEDGER_FILE).write_text("{not json\n")
        with self.assertRaisesRegex(pipeline.PolicyError, "corrupt"):
            pipeline.enforce_render_quota(self.runtime, self.now())

    def test_ledger_is_private(self):
        self.record("started", self.now())
        path = self.root / "var" / "state" / pipeline.LEDGER_FILE
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)


class RetentionTests(OfflineCase):
    def aged(self, path, days):
        stamp = (self.now() - timedelta(days=days)).timestamp()
        os.utime(path, (stamp, stamp))

    def test_prune_respects_each_window(self):
        old_draft = self.root / "var" / "drafts" / "old"
        old_draft.mkdir()
        self.aged(old_draft, 15)
        new_draft = self.root / "var" / "drafts" / "new"
        new_draft.mkdir()
        self.aged(new_draft, 13)
        old_manifest = self.root / "var" / "review" / "old.json"
        old_manifest.write_text("{}")
        self.aged(old_manifest, 91)
        kept_manifest = self.root / "var" / "review" / "kept.json"
        kept_manifest.write_text("{}")
        self.aged(kept_manifest, 30)
        logs = self.root / "var" / "state" / "logs"
        logs.mkdir()
        old_log = logs / "old.log"
        old_log.write_text("x")
        self.aged(old_log, 31)
        gitkeep = self.root / "var" / "drafts" / ".gitkeep"
        gitkeep.write_text("")
        self.aged(gitkeep, 400)

        planned = pipeline.prune(self.runtime, self.now(), dry_run=True)
        self.assertEqual(planned, {"drafts": 1, "review": 1, "logs": 1})
        self.assertTrue(old_draft.exists() and old_manifest.exists() and old_log.exists())

        done = pipeline.prune(self.runtime, self.now())
        self.assertEqual(done, planned)
        self.assertFalse(old_draft.exists() or old_manifest.exists() or old_log.exists())
        self.assertTrue(new_draft.exists() and kept_manifest.exists() and gitkeep.exists())

    def test_prune_never_follows_symlinks(self):
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "precious").write_text("keep")
        link = self.root / "var" / "drafts" / "link"
        link.symlink_to(outside)
        self.assertEqual(pipeline.prune(self.runtime, self.now() + timedelta(days=999))["drafts"], 0)
        self.assertTrue((outside / "precious").exists())

    def test_storage_cannot_escape_var(self):
        runtime = json.loads(json.dumps(self.runtime))
        runtime["storage"]["drafts"] = "../../etc"
        with self.assertRaisesRegex(pipeline.PolicyError, "escapes"):
            pipeline.storage_path(runtime, "drafts")


class HealthcheckTests(OfflineCase):
    def names(self, report):
        return {item["name"]: item for item in report["checks"]}

    def test_reports_every_check_without_stopping(self):
        def broken_toolchain():
            raise pipeline.ToolchainError("no toolchain here")

        report = pipeline.healthcheck(self.runtime, self.brand, toolchain_resolver=broken_toolchain)
        checks = self.names(report)
        self.assertFalse(report["healthy"])
        self.assertEqual(set(checks), {
            "brand_integrity", "runtime_safe", "zero_cost", "activation_flags_false", "kill_switch",
            "lock", "quota", "retention_due", "disk_space", "card_dependencies", "toolchain",
        })
        self.assertFalse(checks["toolchain"]["ok"])
        for name in ("brand_integrity", "runtime_safe", "zero_cost", "activation_flags_false", "kill_switch", "lock", "quota"):
            self.assertTrue(checks[name]["ok"], checks[name])

    def test_kill_switch_makes_healthcheck_unhealthy(self):
        (self.root / "var" / "state" / "KILL").write_text("")
        report = pipeline.healthcheck(self.runtime, self.brand, toolchain_resolver=lambda: None)
        self.assertFalse(self.names(report)["kill_switch"]["ok"])
        self.assertFalse(report["healthy"])

    def test_healthcheck_creates_no_drafts(self):
        pipeline.healthcheck(self.runtime, self.brand, toolchain_resolver=lambda: None)
        self.assertEqual(list((self.root / "var" / "drafts").iterdir()), [])
        self.assertEqual(list((self.root / "var" / "review").iterdir()), [])


class RuntimeSafetyTests(OfflineCase):
    def mutated(self, **changes):
        runtime = json.loads(json.dumps(self.runtime))
        for dotted, value in changes.items():
            target = runtime
            keys = dotted.split("__")
            for key in keys[:-1]:
                target = target[key]
            target[keys[-1]] = value
        return runtime

    def test_committed_runtime_is_safe_and_zero_cost(self):
        pipeline.ensure_runtime_safe(self.runtime)
        for key in ("render_enabled", "routine_enabled", "publication_enabled", "meta_connected"):
            self.assertIs(self.runtime[key], False, key)

    def test_unsafe_runtimes_are_rejected(self):
        cases = {
            "publication": self.mutated(publication_enabled=True),
            "meta": self.mutated(meta_connected=True),
            "paid provider": self.mutated(renderers__higgsfield_seedance_2_5__enabled=True),
            "paid active": self.mutated(renderers__active="higgsfield_seedance_2_5"),
            "local cost": self.mutated(renderers__local_avfoundation__per_render_provider_cost=1),
            "too short": self.mutated(output__duration_seconds=11),
            "too long": self.mutated(output__duration_seconds=21),
            "landscape": self.mutated(output__width=1920, output__height=1080),
            "audio": self.mutated(output__audio=True),
            "codec": self.mutated(output__codec="hevc"),
        }
        for label, runtime in cases.items():
            with self.subTest(label), self.assertRaises(pipeline.PolicyError):
                pipeline.ensure_runtime_safe(runtime)


class BrandingAndOutputTests(OfflineCase):
    def test_every_rotation_is_on_brand(self):
        start = datetime(2026, 10, 4, 0, tzinfo=TZ)
        for hour in range(72):
            plan = pipeline.choose_plan(start + timedelta(hours=hour), self.brand, self.topics)
            pipeline.validate_branding(pipeline.build_storyboard(plan, self.brand, self.runtime), self.brand)

    def manifest(self):
        plan = pipeline.choose_plan(datetime(2026, 10, 4, 9, tzinfo=TZ), self.brand, self.topics)
        return pipeline.build_storyboard(plan, self.brand, self.runtime)

    def test_missing_cta_or_disclosure_is_rejected(self):
        manifest = self.manifest()
        manifest["scenes"][-1]["headline"] = "Call us today"
        with self.assertRaisesRegex(pipeline.PolicyError, "CTA"):
            pipeline.validate_branding(manifest, self.brand)
        manifest = self.manifest()
        manifest["scenes"][-1]["body"] = ""
        with self.assertRaisesRegex(pipeline.PolicyError, "disclosure"):
            pipeline.validate_branding(manifest, self.brand)

    def good_metadata(self):
        return {"width": 1080.0, "height": 1920.0, "duration": 15.0, "fps": 30, "codec_fourcc": "avc1",
                "decodable": True, "audio_tracks": 0, "bytes": 1}

    def test_valid_metadata_passes(self):
        pipeline.validate_video_metadata(self.good_metadata(), self.runtime["output"])

    def test_invalid_metadata_fails(self):
        cases = {
            "landscape": {"width": 1920.0, "height": 1080.0},
            "short": {"duration": 11.5},
            "long": {"duration": 20.5},
            "off target": {"duration": 15.5},
            "codec": {"codec_fourcc": "hvc1"},
            "undecodable": {"decodable": False},
            "audio": {"audio_tracks": 1},
        }
        for label, change in cases.items():
            with self.subTest(label), self.assertRaises(pipeline.PolicyError):
                pipeline.validate_video_metadata({**self.good_metadata(), **change}, self.runtime["output"])


class MetaAdapterTests(OfflineCase):
    def test_adapter_refuses_everything_offline(self):
        adapter = meta_adapter.DisabledMetaAdapter({"meta_connected": True, "publication_enabled": True})
        with self.assertRaises(meta_adapter.PublicationDisabled):
            adapter.publish("video.mp4", caption="x")
        with self.assertRaises(meta_adapter.PublicationDisabled):
            adapter.connect(token="x")
        status = adapter.status()
        self.assertEqual((status["connected"], status["publication_enabled"], status["network"]), (False, False, False))

    def test_no_network_imports_in_pipeline_or_adapter(self):
        for name in ("pipeline.py", "meta_adapter.py"):
            tree = ast.parse((ROOT / "src" / name).read_text(encoding="utf-8"))
            imported = set()
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    imported.update(alias.name.split(".")[0] for alias in node.names)
                elif isinstance(node, ast.ImportFrom) and node.module:
                    imported.add(node.module.split(".")[0])
            self.assertFalse(imported & NETWORK_MODULES, f"{name} imports {imported & NETWORK_MODULES}")

    def test_no_meta_endpoints_anywhere_in_src(self):
        for path in (ROOT / "src").iterdir():
            if path.suffix not in {".py", ".swift"}:
                continue
            source = path.read_text(encoding="utf-8").casefold()
            for needle in ("graph.facebook", "graph.instagram", "access_token", "publish_video", "media_publish"):
                self.assertNotIn(needle, source, f"{needle} in {path.name}")


if __name__ == "__main__":
    unittest.main()
