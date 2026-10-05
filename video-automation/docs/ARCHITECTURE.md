# Architecture and operating contract

## Generation path

`hour slot → deterministic script/language → copy + reading-time validation → timed motion plan → safe-zone layout → frame QA + contact sheet → optional local render → private review queue`

The slot, topic, language, brand version, and template version are hashed into a stable draft ID. Re-running the same slot returns the existing result rather than producing a duplicate.

### Cloud role

Claude Code/Cloud can run the manifest phase because it needs only Python's standard library. The public website is not modified. The current Claude Code web session is signed out, so no cloud routine or repository changes were made during this implementation.

### Mac role

The Mac runner adds the local `render-pilot` step. `src/motion.py` rasterizes 1080x1920 frames at 30 fps (18–24 s, hook → problem → tips → benefit → CTA) from the official artwork. The frames are piped as raw BGRA into a local AVFoundation H.264 encoder. The encoder is built from Swift first. If the only problem is a duplicated `SwiftBridging` module map, Swift is retried through a project-local VFS overlay in `.build/vfs/`, with no system file changed. Failing that, Objective-C equivalents built with `xcrun clang -fno-modules` are used for both binaries.

### Provider audit

Higgsfield is authenticated and usable. A read-only balance check showed a free plan with 5.2 credits. A price-only quote for one 15-second Seedance 2.5 9:16 480p draft was 45 credits. No generation was submitted and no media was uploaded. The provider remains disabled.

## Fail-closed controls

- The hourly script refuses to run unless both the environment gate and config gate are enabled.
- Rendering is separately gated from manifest creation.
- Publication has no implementation and must remain `false`.
- Official asset hashes must match before a manifest or render is accepted.
- Copy is rejected for unsupported ratings, guarantees, certifications, discounts, testimonials, before/after claims, prices, phone numbers, email addresses, or personal data.
- Only one real pilot render (and two attempts) per local wall-clock day is allowed, tracked in `var/state/render-ledger.jsonl`.
- A kill switch (`CALI_CLEAN_VIDEO_KILL=1` or `var/state/KILL`) and an exclusive lock stop renders and concurrent runs.
- Drafts are `qa_pending`; there is no automatic promotion.

## Retention

- Draft media: 14 days
- Review manifests/storyboards: 90 days
- Build/render/inspect diagnostic logs (`var/state/logs`): 30 days
- No published-media retention policy is active because publication is disabled

Pruning is implemented but runs only from the disabled hourly entry point. Every retained manifest includes the hashes required to reproduce its content decision.

