# Direct screen capture verification

Production product source: `678e96de02f2ab0bcab5838bbd2634d64c390485`. This gallery covers the direct **Screenshot this screen** / **Record this screen** flow, with existing-file upload as a secondary action. All **16 scenarios passed**, with zero browser exceptions, in Chromium 154.0.8037.57 on November 3, 2026. The browser run uses a fresh profile, real application authentication and API validation, a disposable SQLite database, and synthetic Linear delivery on loopback. No real tickets, uploads, user screens, camera or microphone are used.

[Results](results.json), [production build output](build.txt), and [bundle hashes](bundle-sha256.txt) identify the tested artifact. `dirty: true` in the results reflects an additional harness-only stacking regression check; the product source and built bundle are the committed revision above. The evidence files are added afterward. The final source diff does not change production code.

## Gallery

| State | Desktop light | Mobile dark |
| --- | --- | --- |
| Direct capture actions | [1440px](light-1440-capture-actions.png) | [390px](dark-390-capture-actions.png) |
| Composer hidden, recording controls available | [1440px](light-1440-synthetic-recording-active.png) | [390px](dark-390-synthetic-recording-active.png) |
| Screenshot returned for review | [1440px](light-1440-synthetic-screenshot-preview.png) | [390px](dark-390-synthetic-screenshot-preview.png) |
| Decoded recording returned for review | [1440px](light-1440-synthetic-recording-preview.png) | [390px](dark-390-synthetic-recording-preview.png) |

- [Recording controls inside Orca's Compose dialog](capture-controls-in-compose.png)
- [Feedback review above still-open Compose after Stop](capture-review-above-compose.png)
- [Compose restored after closing feedback](compose-restored-after-feedback.png)

## Coverage and limits

The matrix retains six text-feedback scenarios (light/dark at 1440, 390 and 320px), four attachment/retry scenarios (light/dark at 1440 and 320px), and capability-response ordering coverage. Four direct-capture scenarios run light/dark at 1440 and 390px. A separate real Compose-dialog scenario tests recording-control focus and stacking.

Capture verification checks primary labels, current-tab preference and browser-surface constraints, `audio: false`, absence of the composer/backdrop during capture, background interaction, accessible Stop/Cancel controls, keyboard shortcuts, preserved drafts, and explicit review before submission. A probe at actual screenshot frame extraction verifies the composer, backdrop and recording controls are hidden. The synthetic screenshot and recording pass API validation and synthetic delivery. In each of the four direct-capture scenarios, video playback must advance with a decoded frame and nonzero dimensions before its preview screenshot is taken. The separate stacking screenshot captures metadata loading; it proves feedback placement and interaction, not playback.

Cleanup checks cover Stop, Cancel, browser permission rejection, a late chooser result after cancellation, hidden-tab cancellation, capability-loss unmount, a simulated 60-second limit, and a synthetic oversized recorder chunk. All observed capture tracks must end. The time-limit test advances the page's monotonic clock; it is not a real-time endurance test. The oversized-chunk test exercises rejection and cleanup, not natural encoder bitrate growth.

`getDisplayMedia` is replaced with generated canvas streams; the real browser MediaRecorder encodes those frames. The screenshot probes establish UI state at frame extraction, not real operating-system capture pixel fidelity. Native UIKit/ReplayKit, the browser's real permission chooser, actual Linear storage and non-Chromium behavior require separate evidence. External browser requests are blocked.

Reproduce after building with `bash scripts/ci/feedback-ticket-check.sh /tmp/new-direct-capture-evidence`; set `ORCA_CHROMIUM_EXECUTABLE` when using installed Chromium. The runner stops its owned fixture on exit. Earlier developmental attempt 1 failed because a styled radio's span intercepted the harness's input click; clicking its visible label corrected the selector. Attempt 2 passed before the final monotonic-clock and stacking verification.
