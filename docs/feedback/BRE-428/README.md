# Current-screen feedback — BRE-428

[Draft PR #286](https://github.com/lukebrevoort/orca/pull/286) adds a persistent corner button, a small composer, and a confirmed Linear ticket. Linear is the work queue; there is no separate dashboard, migration or autonomous coding agent.

## Direct capture

**Screenshot this screen** and **Record this screen** are the primary context actions. File selection remains secondary; users do not need to take a screenshot elsewhere and upload it.

- **Web:** the composer and backdrop disappear before requesting browser capture. The current Orca tab is preferred, but the browser controls its permission/source chooser; choose the Orca tab if prompted. Screenshot extraction also hides the capture controls. During recording the app remains interactive, with a visible Stop/Cancel bar that follows opened app dialogs. Stop also works with Ctrl/Cmd+Shift+X. Ending capture returns the existing draft and the captured media for review.
- **iOS:** Screenshot captures the originating Orca window after the feedback sheet dismisses. Record uses ReplayKit app-screen capture and a video-only MP4 writer. A visible Stop/Cancel bar remains above app sheets. Capture is limited to Orca, not other apps. Recording requires an available recorder and a foreground scene with visible controls; unsupported devices show an actionable error.
- **Both:** capture starts only from a user action. Recordings are silent and stop after 60 seconds, with bounded file sizes. Cancellation, owner changes and leaving the active app/tab discard capture. Nothing is uploaded until the user reviews the result and sends feedback. Capture permission prompts and unsupported APIs are not bypassed.

Only the configured, authenticated owner sees this personal integration. Review captured content for unrelated mail, passwords or other private information before sending. Selecting existing videos can retain their original audio and metadata; new recordings contain no audio.

## Bounds, delivery and cleanup

Up to three PNG, JPEG, WebP, MP4, WebM or MOV files are allowed: 10 MiB each, 20 MiB total. Images are re-encoded without private source EXIF/GPS. Native previews and capture files use protected app-local storage and are cleaned on removal, successful delivery, cancellation/account change and subsequent launch after interruption. Drafts are memory-only; they survive composer closure but not process termination.

The owner-authenticated API validates count, byte totals, canonical base64 and container signatures. These checks are not full decoding or malware scanning. Attachment content participates in stable issue identity; exact retries reconcile the same issue, including archived issues. Upload failures never produce a false success or ticket link.

Linear's [file upload API](https://linear.app/developers/how-to-upload-a-file-to-linear) and [authenticated private storage](https://linear.app/developers/file-storage-authentication) provide the storage destination. No public bucket or new storage account is introduced. Only private asset receipts are cached (30 minutes, at most 100 entries), not media bytes or signed PUT URLs. Private unreferenced assets may remain after partial failure, expiry or restart: there is no documented safe general-purpose deletion API, and the internal destructive deletion mutation is not used.

## Verification

The PR records the exact latest head, immutable review and hosted results. The previous file-selection revision `f9f1a7fb948ccff5567e84b38b8d4481faa0947a` passed all hosted workflows, 2,108 unit tests, ten native feedback model tests and Photos PNG/MP4 review/retry in both themes. Those results do not verify the subsequent direct-capture change.

Direct-capture verification uses synthetic browser canvas streams with the real MediaRecorder, actual UIKit screenshots of the synthetic native app, injected recording lifecycle tests and a real AVAssetWriter fed synthetic frames. A successful fake session or writer test does not establish ReplayKit recording on physical hardware. Browser permission-picker behavior/current-tab compositor timing and physical-device ReplayKit remain explicit manual checks. Native artifacts have not been visually inspected through the previously blocked download proxy; do not bypass that restriction.

Historical galleries remain available for comparison: [text flow](evidence/results.json), [file-selection/media gallery](media-evidence/README.md). The updated direct-capture gallery and current run links are provided in the PR.

Reproduce the production browser fixture with frozen dependencies and an installed browser:

```sh
bun install --frozen-lockfile
bun run build
ORCA_CHROMIUM_EXECUTABLE=/usr/bin/chromium bash scripts/ci/feedback-ticket-check.sh /tmp/orca-feedback-direct-evidence
python3 scripts/ci/test-export-evidence.py
```

Fixtures bind loopback, use synthetic users and mocked Linear delivery, and clean their own processes/databases. Do not use live credentials, mail databases, browser profiles or private media as test input.

## Backend activation

Configure the backend service with secret `LINEAR_API_KEY` and non-secret `LINEAR_FEEDBACK_OWNER_USER_ID`. The owner value is the exact `user.id` from the signed-in `/v1/auth/session` response, including any prefix such as `user_`; it is not the Linear user ID. Never put the key in frontend/native configuration or publish its value. Destination override variable names/defaults are in `.env.example`.

A team-restricted Read + Create issues key covers core lookup/creation. The minimum permission required for `fileUpload` remains an activation check; do not assume broader access is needed. Railway changes can be staged without deployment and take effect when applied. Coordinate owner configuration, key-permission verification and client/backend rollout only after approval. This PR does not authorize merge, deployment, production migration or release.
