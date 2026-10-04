# CaliClean private video-draft generator

This project creates **private, review-only vertical video drafts** for Cali Clean. It does not connect to Meta, publish posts, send messages, or modify the public website.

## Current safety state

- Hourly routine: **disabled**
- Real rendering from the hourly runner: **disabled**
- Publishing: **disabled**
- Meta/Facebook/Instagram API access: **not configured**
- Allowed output: one dry-run manifest and at most one local pilot render per day
- Storage: local private `var/` directories (`0700`) and files (`0600`)

The generator rotates through the eight services stated on the official website, alternates English and Spanish, and produces a deterministic 15-second, 9:16 storyboard. It validates asset hashes, copy, brand colors, privacy constraints, and idempotency before creating anything.

## Architecture

1. **Claude Code / Cloud orchestration** — intended to select a slot, generate and validate the manifest, and enqueue review metadata. Claude Code itself does not render video.
2. **Mac renderer** — uses the built-in macOS AVFoundation encoder and official Cali Clean website artwork to render an MP4 with no external generation charge.
3. **Private review queue** — stores the MP4, storyboard, and machine-readable manifest. Publication remains a separate, disabled future phase.

The existing Claude Code session was signed out during implementation, so this repository is staged locally for import/push when that session is available. Nothing was uploaded to Claude Cloud.

## Commands

Use a Python that includes Pillow (with FreeType WOFF2 support for `assets/manrope.woff2`):

```sh
PY=/Users/gv/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3
$PY -m unittest discover -s tests -v
$PY src/pipeline.py healthcheck          # read-only; exit 0 only when ready to render
$PY src/pipeline.py dry-run --slot 2026-10-04T09:00:00-07:00
$PY src/pipeline.py render-pilot --supervised --slot 2026-10-04T09:00:00-07:00
```

`render-pilot` refuses to run without `--supervised`. It renders at most one draft per call and per local day.

The hourly entry point fails closed until `config/runtime.json` is intentionally changed and `VIDEO_ROUTINE_ENABLED=true` is set:

```sh
scripts/run-hourly
```

## Render toolchain

Swift is always tried first. Sources are compiled with `xcrun --sdk macosx swiftc`, which uses the SDK selected by `xcode-select`. The build passes `-sdk`, `-target <arch>-apple-macos13.0`, `-swift-version 5` and a private module cache at `.build/module-cache/<binary>`. That cache is wiped before every build. Binaries are rebuilt only when the source hash or toolchain fingerprint changes.

### Objective-C fallback (project-local)

Sometimes Command Line Tools ship a `swiftc` that does not match their SDK. The typical error is `error: redefinition of module 'SwiftBridging'` or `could not build C module 'SwiftShims'`. In that case the pipeline builds `src/render_mp4.m` and `src/inspect_mp4.m` instead. Both are Objective-C equivalents with the same CLI and JSON output, built with:

```sh
xcrun --sdk macosx clang -x objective-c -fobjc-arc -fno-modules -isysroot <SDK> -arch <arch> \
  -mmacosx-version-min=13.0 -O2 -Wall -Wno-deprecated-declarations -Werror=implicit-function-declaration \
  src/render_mp4.m -o .build/render_mp4-objc \
  -framework Foundation -framework AVFoundation -framework CoreMedia -framework CoreVideo -framework CoreGraphics -framework ImageIO
```

`-fno-modules` makes clang include headers textually, so the conflicting module maps are never read. No system file is modified; everything is written under `.build/` and `var/`.

The Objective-C renderer creates every BGRA frame with `CVPixelBufferCreate`. Attributes are explicit: CGImage/CGBitmapContext compatible and IOSurface-backed. It checks every `CVReturn`, lock and unlock, and uses the writer adaptor only to append frames. The adaptor's own buffer pool is not used. Under this build it crashed with `EXC_BREAKPOINT` in `CFGetTypeID` ← `CVPixelBufferPoolCreatePixelBuffer`.

How the fallback behaves:

- **Coherent backend:** if either Swift binary fails for a toolchain/SDK reason, both renderer and inspector use Objective-C. They are never mixed.
- **Real Swift code errors are not masked:** a type error, for example, stops the run.
- **Swift is retried first on every run:** the Objective-C binaries are cached by source and toolchain fingerprint.
- **Missing clang:** if Swift is unusable and clang is unavailable, the run stops.
- **Recorded in the manifest:** `render.backend` (`swift` or `objc`) and `render.fallback_reason` (the exact compiler line).

The full command, exit code, stdout and stderr of every build, render and inspection step are written to `var/state/logs/` (mode `0600`, kept for 30 days). The pipeline never runs `xcode-select --install`, `sudo`, or license commands. If Command Line Tools are missing or the Xcode license is not accepted, it stops with `Blocked: …` and waits for a human.

## Fail-closed guards

- **Kill switch:** `CALI_CLEAN_VIDEO_KILL=1` or a file `var/state/KILL` blocks every render and the hourly script.
- **Lock:** `var/state/pipeline.lock` (an exclusive `flock`) refuses concurrent runs.
- **Quota:** `var/state/render-ledger.jsonl` counts renders by wall-clock day, not by requested slot. Limits are 1 completed render and 2 attempts per day. A corrupt ledger blocks rendering.
- **Quota override (closed by default):** once the normal daily quota is spent, `render-pilot --supervised --quota-override-reason "<why>"` allows **one** extra attempt that day.
  - The reason must be non-empty (at most 500 characters).
  - Refused with any other command, without `--supervised`, while normal quota remains, or when the day's override was already used.
  - The ledger records a `quota_override` event with the reason and the usage it overrode. A failed override attempt still consumes it.
- **Retention:** drafts are kept 14 days, manifests 90 days and logs 30 days. Pruning skips symlinks and never leaves `var/`. `healthcheck` reports what is due without deleting anything.
- **Output validation:** 1080x1920 H.264, 12–20 s and within 0.2 s of target, no audio, first and last frames decodable. The final scene must show the official `cali-clean.net` CTA and the AI-visual disclosure.
- **Cost:** only `local_avfoundation` with zero provider cost may be active. Any enabled paid provider blocks the run.
- **Meta:** `src/meta_adapter.py` is a disabled stub with no network code; `connect`/`publish` always raise.

## External engine audit

Higgsfield is connected, but a 15-second 9:16 Seedance draft was quoted at **45 credits** while the available balance was **5.2 credits**. No job, purchase, trial, or charge was submitted. The pilot therefore uses the local AVFoundation path, which has no per-render provider charge.

## Activation gates

The hourly routine must stay disabled until all items in [docs/QA_CHECKLIST.md](docs/QA_CHECKLIST.md) pass and the Claude Code repository/session is available. Publishing is intentionally out of scope and must remain disabled.

