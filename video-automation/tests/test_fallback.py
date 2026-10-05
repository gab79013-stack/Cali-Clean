"""Swift-first build with a project-local Objective-C fallback (offline, no real compiler)."""

import json
import re
import subprocess
import unittest
from pathlib import Path
from unittest import mock

import test_guards as guards

pipeline = guards.pipeline
ROOT = guards.ROOT

# What Command Line Tools print when their swift/bridging module map collides with the SDK's.
SWIFT_BRIDGING_FAILURE = "\n".join([
    "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/swift/module.modulemap:1:8: "
    "error: redefinition of module 'SwiftBridging'",
    "module SwiftBridging {",
    "       ^",
    "/Library/Developer/CommandLineTools/usr/include/swift/bridging.modulemap:1:8: note: previously defined here",
    *[f"note: while building module chain line {i}" for i in range(80)],
    "<unknown>:0: error: could not build C module 'SwiftShims'",
])
SWIFT_CODE_ERROR = "render_mp4.swift:12:9: error: cannot convert value of type 'Int' to expected argument type 'String'"


def toolchain(swiftc="/fake/swiftc", clang="/fake/clang"):
    return pipeline.Toolchain(
        xcrun=pipeline.XCRUN, swiftc=swiftc, sdk_path="/fake/sdk", sdk_version="15.0",
        target="arm64-apple-macos13.0", swiftc_version="Apple Swift version 6.0" if swiftc else "",
        clang=clang, clang_version="Apple clang version 16.0.0" if clang else "",
    )


class Compilers:
    """Fake compiler runner: swiftc/clang behaviour is scripted per source file."""

    def __init__(self, swift=None, clang=None):
        self.swift = swift or {}
        self.clang = clang or {}
        self.calls = []

    def __call__(self, command, timeout, env=None):
        self.calls.append(command)
        compiler = command[3]
        source = Path(next(arg for arg in command if arg.endswith((".swift", ".m")))).name
        failure = (self.swift if compiler == "swiftc" else self.clang).get(source)
        if failure:
            return subprocess.CompletedProcess(command, 1, "", failure)
        Path(command[command.index("-o") + 1]).write_text(f"{compiler} binary for {source}")
        return subprocess.CompletedProcess(command, 0, "", "")

    def by(self, compiler):
        return [call for call in self.calls if call[3] == compiler]


class FallbackSelectionTests(guards.OfflineCase):
    def build(self, runner, tc=None):
        logs = []
        built = pipeline.build_renderers(tc or toolchain(), logs, self.root / "var" / "state" / "logs", runner)
        return built, logs

    def test_detects_swiftbridging_redefinition(self):
        reason = pipeline.swift_incompatibility(SWIFT_BRIDGING_FAILURE)
        self.assertIn("redefinition of module 'SwiftBridging'", reason)

    def test_ordinary_code_errors_are_not_incompatibilities(self):
        self.assertIsNone(pipeline.swift_incompatibility(SWIFT_CODE_ERROR))
        self.assertIsNone(pipeline.swift_incompatibility(""))

    def test_swift_is_used_first_when_it_works(self):
        runner = Compilers()
        built, logs = self.build(runner)
        self.assertEqual(built["backend"], "swift")
        self.assertIsNone(built["fallback_reason"])
        self.assertEqual(built["render"].name, "render_mp4")
        self.assertEqual(built["inspect"].name, "inspect_mp4")
        self.assertEqual(runner.by("clang"), [])

    def test_swiftbridging_failure_falls_back_to_objc_for_both(self):
        runner = Compilers(swift={"render_mp4.swift": SWIFT_BRIDGING_FAILURE})
        built, logs = self.build(runner)
        self.assertEqual(built["backend"], "objc")
        self.assertIn("SwiftBridging", built["fallback_reason"])
        self.assertEqual((built["render"].name, built["inspect"].name), ("render_mp4-objc", "inspect_mp4-objc"))
        self.assertTrue(built["render"].exists() and built["inspect"].exists())
        clang_sources = sorted(Path(next(a for a in c if a.endswith(".m"))).name for c in runner.by("clang"))
        self.assertEqual(clang_sources, ["inspect_mp4.m", "render_mp4.m"])
        self.assertIn({"step": "fallback:objc", "reason": built["fallback_reason"]}, logs)
        # The full swiftc output, including the classifying first line, is in the build log.
        swift_log = next(Path(entry["log"]) for entry in logs if entry.get("compiler") == "swiftc")
        self.assertIn("redefinition of module 'SwiftBridging'", swift_log.read_text())

    def test_backend_is_coherent_when_only_the_inspector_breaks(self):
        runner = Compilers(swift={"inspect_mp4.swift": SWIFT_BRIDGING_FAILURE})
        built, _ = self.build(runner)
        self.assertEqual(built["backend"], "objc")
        self.assertEqual((built["render"].name, built["inspect"].name), ("render_mp4-objc", "inspect_mp4-objc"))

    def test_real_swift_bugs_are_never_masked(self):
        runner = Compilers(swift={"render_mp4.swift": SWIFT_CODE_ERROR})
        with self.assertRaises(pipeline.CompileError):
            self.build(runner)
        self.assertEqual(runner.by("clang"), [])

    def test_missing_swiftc_goes_straight_to_objc(self):
        runner = Compilers()
        built, logs = self.build(runner, toolchain(swiftc=""))
        self.assertEqual(built["backend"], "objc")
        self.assertEqual(runner.by("swiftc"), [])
        self.assertEqual(built["fallback_reason"], "swiftc not available through xcrun")

    def test_no_clang_and_broken_swift_fails_closed(self):
        runner = Compilers(swift={"render_mp4.swift": SWIFT_BRIDGING_FAILURE})
        with self.assertRaisesRegex(pipeline.ToolchainError, "clang is not available"):
            self.build(runner, toolchain(clang=""))

    def test_objc_failure_keeps_full_diagnostics(self):
        runner = Compilers(
            swift={"render_mp4.swift": SWIFT_BRIDGING_FAILURE},
            clang={"render_mp4.m": "render_mp4.m:10:1: error: unknown type name 'Foo'"},
        )
        with self.assertRaises(pipeline.CompileError) as ctx:
            self.build(runner)
        self.assertIn("clang failed for render_mp4.m", str(ctx.exception))
        self.assertIn("unknown type name 'Foo'", ctx.exception.log_path.read_text())
        self.assertEqual(ctx.exception.log_path.stat().st_mode & 0o777, 0o600)

    def test_swift_is_retried_first_but_objc_binaries_are_cached(self):
        runner = Compilers(swift={"render_mp4.swift": SWIFT_BRIDGING_FAILURE})
        self.build(runner)
        self.build(runner)
        self.assertEqual(len(runner.by("swiftc")), 2)
        self.assertEqual(len(runner.by("clang")), 2)

    def test_everything_stays_inside_the_project(self):
        runner = Compilers(swift={"render_mp4.swift": SWIFT_BRIDGING_FAILURE})
        self.build(runner)
        for command in runner.calls:
            output = Path(command[command.index("-o") + 1])
            self.assertIn(self.root, output.parents)
            if "-module-cache-path" in command:
                cache = Path(command[command.index("-module-cache-path") + 1])
                self.assertIn(self.root / ".build" / "module-cache", cache.parents)


class ClangCommandTests(guards.OfflineCase):
    def test_clang_command_is_portable_and_module_free(self):
        cache = self.root / "cache"
        command = pipeline.clang_objc_command(toolchain(), Path("render_mp4.m"), Path("out"), cache)
        self.assertEqual(command[:4], [pipeline.XCRUN, "--sdk", "macosx", "clang"])
        for flag in ("-fobjc-arc", "-fno-modules", "-mmacosx-version-min=13.0", "-Werror=implicit-function-declaration"):
            self.assertIn(flag, command)
        self.assertNotIn("-fmodules", command)
        self.assertEqual(command[command.index("-isysroot") + 1], "/fake/sdk")
        self.assertEqual(command[command.index("-arch") + 1], "arm64")
        frameworks = {command[i + 1] for i, arg in enumerate(command) if arg == "-framework"}
        self.assertEqual(frameworks, {"Foundation", "AVFoundation", "CoreMedia", "CoreVideo", "CoreGraphics", "ImageIO"})

    def test_clang_build_env_uses_private_cache(self):
        captured = {}

        def runner(command, timeout, env=None):
            captured.update(env)
            Path(command[command.index("-o") + 1]).write_text("bin")
            return subprocess.CompletedProcess(command, 0, "", "")

        pipeline.compile_objc(toolchain(), "render_mp4-objc", pipeline.SRC_DIR / "render_mp4.m", [],
                              self.root / "logs", runner)
        self.assertEqual(captured["CLANG_MODULE_CACHE_PATH"], str(self.root / ".build" / "module-cache" / "render_mp4-objc"))


class ResolveWithFallbackTests(guards.OfflineCase):
    def responses(self, **overrides):
        base = {
            "xcode-select -p": (0, "/Library/Developer/CommandLineTools\n", ""),
            "--show-sdk-path": (0, f"{self.temp.name}\n", ""),
            "--show-sdk-version": (0, "15.0\n", ""),
            "--find swiftc": (0, "/fake/swiftc\n", ""),
            "swiftc --version": (0, "Apple Swift version 6.0\n", ""),
            "--find clang": (0, "/fake/clang\n", ""),
            "clang --version": (0, "Apple clang version 16.0.0\n", ""),
        }
        base.update(overrides)
        return base

    def resolve(self, responses):
        return pipeline.resolve_toolchain(platform_name="darwin", machine="arm64",
                                          runner=guards.fake_runner(responses), exists=lambda path: True)

    def test_resolves_both_compilers(self):
        tc = self.resolve(self.responses())
        self.assertEqual((tc.swiftc, tc.clang), ("/fake/swiftc", "/fake/clang"))
        self.assertEqual(tc.clang_version, "Apple clang version 16.0.0")

    def test_broken_swiftc_lookup_still_allows_clang(self):
        tc = self.resolve(self.responses(**{"--find swiftc": (72, "", "xcrun: error: unable to find utility \"swiftc\"")}))
        self.assertEqual((tc.swiftc, tc.clang), ("", "/fake/clang"))

    def test_no_compiler_at_all_fails_closed(self):
        missing = (72, "", "xcrun: error: unable to find utility")
        with self.assertRaisesRegex(pipeline.ToolchainError, "Neither swiftc nor clang"):
            self.resolve(self.responses(**{"--find swiftc": missing, "--find clang": missing}))

    def test_license_prompt_on_clang_still_stops_for_a_human(self):
        responses = self.responses(**{"--find clang": (69, "", "Agreeing to the Xcode/iOS license requires admin privileges")})
        with self.assertRaisesRegex(pipeline.ToolchainError, "Blocked"):
            self.resolve(responses)

    def test_fingerprint_changes_with_clang(self):
        self.assertNotEqual(toolchain().fingerprint(), toolchain(clang="/other/clang").fingerprint())


class SourceParityTests(guards.OfflineCase):
    def read(self, name):
        return (ROOT / "src" / name).read_text(encoding="utf-8")

    def test_objc_sources_are_headless_and_use_expected_frameworks(self):
        render, inspect = self.read("render_mp4.m"), self.read("inspect_mp4.m")
        for source in (render, inspect):
            self.assertNotRegex(source, r"#import\s*<AppKit/")
            self.assertNotRegex(source, r"(?m)^\s*@import\b", "@import would require modules")
            self.assertIn("#import <AVFoundation/AVFoundation.h>", source)
        for header in ("CoreVideo/CoreVideo.h", "CoreMedia/CoreMedia.h"):
            self.assertIn(header, render)
        self.assertIn("fread(", render)
        self.assertIn("shouldOptimizeForNetworkUse = YES", render)

    def test_inspectors_emit_the_same_keys(self):
        keys = {"duration", "width", "height", "fps", "codec_fourcc", "audio_tracks", "decodable", "bytes"}
        swift_keys = set(re.findall(r'"(\w+)":', self.read("inspect_mp4.swift")))
        objc_keys = set(re.findall(r'@"(\w+)":', self.read("inspect_mp4.m")))
        self.assertEqual(swift_keys & keys, keys)
        self.assertEqual(objc_keys, keys)

    def test_renderers_share_cli_and_output(self):
        usage = "usage: render_mp4 OUTPUT WIDTH HEIGHT FPS FRAMES < raw BGRA frames on stdin"
        self.assertIn(usage, self.read("render_mp4.swift"))
        self.assertIn(usage, self.read("render_mp4.m"))
        for key in ("status", "output", "width", "height", "fps", "duration", "frames"):
            self.assertIn(f'"{key}"', self.read("render_mp4.swift"))
            self.assertIn(f'@"{key}"', self.read("render_mp4.m"))


try:
    import PIL  # noqa: F401
    HAS_PIL = True
except ImportError:
    HAS_PIL = False


@unittest.skipUnless(HAS_PIL, "Pillow is required to rasterize frames")
class RenderVideoWithFallbackTests(guards.OfflineCase):
    """Drives render_video end to end with fake compilers, a fake encoder and inspector; nothing is encoded."""

    def test_streams_every_frame_and_reports_objc_backend_and_zero_cost(self):
        compilers = Compilers(swift={"render_mp4.swift": SWIFT_BRIDGING_FAILURE})
        logs = []
        built = pipeline.build_renderers(toolchain(), logs, self.root / "var" / "state" / "logs", compilers)
        self.assertEqual(built["backend"], "objc")
        plan = pipeline.choose_plan(pipeline.parse_slot("2026-10-05T10:00:00-07:00", self.runtime["timezone"]), self.brand, self.topics)
        manifest = pipeline.build_storyboard(plan, self.brand, self.runtime, self.topics)
        paths = pipeline.output_paths(self.runtime, manifest["draft_id"])
        received = {}

        def streamer(command, frames, timeout, step, log_dir, log_list):
            count = total = 0
            for chunk in frames:
                count += 1
                total += len(chunk)
            received.update(command=command, frames=count, bytes=total)
            Path(command[1]).write_bytes(b"fakemp4")
            log_list.append({"step": step, "exit_code": 0, "frames_sent": count})
            return subprocess.CompletedProcess(command, 0, '{"status":"ok"}', "")

        metadata = {"width": 1080.0, "height": 1920.0, "duration": manifest["output"]["duration_seconds"], "fps": 30,
                    "codec_fourcc": "avc1", "decodable": True, "audio_tracks": 0, "bytes": 7}

        def runner(command, timeout, env=None):
            self.assertTrue(command[0].endswith("inspect_mp4-objc"))
            return subprocess.CompletedProcess(command, 0, json.dumps(metadata), "")

        record = pipeline.render_video(manifest, self.brand, self.runtime, paths, built, logs, runner, streamer)
        frames = manifest["output"]["frames"]
        self.assertEqual(received["frames"], frames)
        self.assertEqual(received["bytes"], frames * 1080 * 1920 * 4)
        self.assertEqual(received["command"][-4:], ["1080", "1920", "30", str(frames)])
        self.assertEqual(record["backend"], "objc")
        self.assertIn("SwiftBridging", record["fallback_reason"])
        self.assertEqual(record["provider_cost"], 0)
        self.assertEqual(paths["video"].stat().st_mode & 0o777, 0o600)
        sheet = Path(record["qa"]["contact_sheet"]["path"])
        self.assertTrue(sheet.exists())
        self.assertGreaterEqual(len(record["qa"]["contact_sheet"]["moments"]), 8)
        steps = [entry["step"] for entry in record["logs"]]
        self.assertIn("fallback:objc", steps)
        self.assertEqual(steps[-2:], ["render", "inspect"])


if __name__ == "__main__":
    import unittest

    unittest.main()
