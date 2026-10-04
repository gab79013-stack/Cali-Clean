# Activation checklist

Keep the hourly routine disabled until all items are complete.

- [x] Brand facts and services are sourced from the official English and Spanish pages.
- [x] Official image and font hashes are pinned.
- [x] Unsupported claims and personal data are rejected.
- [x] English/Spanish selection is deterministic.
- [x] Same-hour retries are idempotent.
- [x] Private storage permissions are enforced.
- [x] No Meta endpoint, account, token, or publication action is present.
- [x] Higgsfield cost is quoted without submitting a job.
- [x] Swift build uses `xcrun --sdk macosx swiftc` with a private, clean module cache and full diagnostic logs.
- [x] Kill switch, lock, wall-clock quota ledger, retention and disabled Meta adapter are covered by offline tests.
- [x] Objective-C fallback (`render_mp4.m`, `inspect_mp4.m`) builds with `xcrun clang -fno-modules` when Swift hits a toolchain/SDK mismatch; covered by offline tests.
- [ ] `src/pipeline.py healthcheck` exits 0 on the Mac runner.
- [ ] The manifest of the pilot render records which backend (`swift`/`objc`) produced it.
- [ ] One supervised `render-pilot --supervised` produces a validated 1080x1920, 12–20 s MP4.
- [ ] Pilot MP4 has been visually reviewed by a human.
- [ ] Claude Code session/repository is available and the local commit is imported.
- [ ] Mac Mini runner is selected and remains online for one supervised hourly cycle.
- [ ] Storage retention and disk monitoring are confirmed on that Mac.
- [ ] `render_enabled` is changed only after pilot approval.
- [ ] `routine_enabled` is changed only after one supervised cycle.

Publication to Facebook or Instagram is a separate future project and is not an activation item here.

