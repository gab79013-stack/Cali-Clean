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

Use the bundled Python environment that includes Pillow:

```sh
PY=/Users/gv/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3
$PY src/pipeline.py dry-run --slot 2026-10-04T09:00:00-07:00
$PY src/pipeline.py render-pilot --slot 2026-10-04T09:00:00-07:00
$PY -m unittest discover -s tests -v
```

The hourly entry point fails closed until `config/runtime.json` is intentionally changed and `VIDEO_ROUTINE_ENABLED=true` is set:

```sh
scripts/run-hourly
```

## External engine audit

Higgsfield is connected, but a 15-second 9:16 Seedance draft was quoted at **45 credits** while the available balance was **5.2 credits**. No job, purchase, trial, or charge was submitted. The pilot therefore uses the local AVFoundation path, which has no per-render provider charge.

## Activation gates

The hourly routine must stay disabled until all items in [docs/QA_CHECKLIST.md](docs/QA_CHECKLIST.md) pass and the Claude Code repository/session is available. Publishing is intentionally out of scope and must remain disabled.

