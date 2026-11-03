# Synthetic media verification

The production web bundle at `89c5e1d4d931bf9c531820d55f2ab5f0f6c131dc` passed all 12 browser scenarios on November 3, 2026 in Chromium 154.0.8037.57. [Results](results.json) record a clean worktree and zero page errors. [Build output](build.txt) and [bundle hashes](bundle-sha256.txt) identify the bundle used. The loopback fixture uses a fresh SQLite database, real application authentication and API validation, and injected synthetic Linear delivery. No real tickets or uploads were created. Non-loopback browser requests, including fonts, were blocked.

The six text scenarios cover light/dark at 1440, 390 and 320px. Four attachment scenarios cover light/dark at 1440 and 320px: image/video previews, removal, review gating, invalid type/corrupt image/oversize rejection, failure without false success, and retry with identical attachment bytes and IDs producing one synthetic issue. Additional scenarios verify capability-response ordering and private-draft cleanup, plus screen capture lifecycle.

Capture uses generated canvas streams in place of `getDisplayMedia`; it never reads a desktop, camera or microphone. The real browser MediaRecorder encodes generated frames, and the resulting screenshot and video pass the application's API validation and synthetic delivery. All six created streams ended; all seven capture requests specified `audio: false`. Tests exercise Stop, Cancel, pending chooser closure, active recording closure, and chooser rejection. The 60-second stop branch uses a simulated clock advance, not a real-time endurance run.

## Gallery

| State | Light | Dark |
| --- | --- | --- |
| Desktop attachment review | [1440px](light-1440-media-review.png) | [1440px](dark-1440-media-review.png) |
| Narrow mobile attachment review | [320px](light-320-media-review.png) | [320px](dark-320-media-review.png) |

- [Generated screenshot preview](synthetic-screenshot-preview.png)
- [Active recording with Stop and Cancel](synthetic-recording-active.png)
- [Stopped recording preview](synthetic-recording-preview.png)
- [Synthetic capture ticket confirmation](synthetic-capture-sent.png)
- [Uploading/confirmation state](light-1440-media-uploading.png)
- [Failed delivery retains reviewed media for retry](dark-320-media-retry.png)
- [Capability restored with an empty composer](capability-recovery-empty.png)

The active/stopped recording screenshots come from a second matrix run against the same production bundle, with screenshot timing/scroll position improved and an additional playback assertion in the harness. The recorded clip must play with advancing current time, decoded frame readiness and nonzero video dimensions before it is paused for the screenshot. [Gallery run results](gallery-results.json) therefore report a dirty worktree; no product code changed. Other gallery images and the primary results come from the clean committed run.

## Reproduction and limits

Build the web app, then run `bash scripts/ci/feedback-ticket-check.sh /tmp/new-feedback-evidence` with Bun, Node and Playwright Chromium available. `ORCA_CHROMIUM_EXECUTABLE` can select an installed Chromium. The runner stops its disposable fixture after completion. Synthetic upload assets live in `apps/web/scripts/fixtures/feedback-media/`.

This evidence verifies Chromium against synthetic capture and delivery. It does not verify an operating-system screen chooser, actual Linear asset storage, native iOS UI, Safari/Firefox recording support, or production credentials. Native simulator evidence and broader unit/CI results are tracked separately. The evidence exporter tests passed 15/15 locally.
