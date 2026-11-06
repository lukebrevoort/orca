# BRE-443: consented web image latency

The synthetic baseline demonstrates two delays: images download sequentially, and the web receives nothing until the whole response is ready. With twelve 150 ms synthetic downloads, the first image appears only after about 1.87 seconds. Progressive delivery with two tasks per message brings that to about 0.19 seconds while retaining the process-wide four-task ceiling.

This does **not** establish the cause of Luke's live newsletter delay. No real mailbox, sender image, CDN or DNS request was used.

## Reproducible comparison

- Application baseline: main `2f4b2f8e216635696cf09f5dc8cf7c64e6f11204` plus diagnostic-only harness commit `6c6cc7928197e571ebe5bfa68206a2805f1df1a8`.
- Candidate executable: `e9ad28001c301dbfd3134cb5155f3178e7c320a1`.
- Actual production-built web app and loopback Bun API, SQLite, cookie auth, origin guard and source revisions. The downloader is replaced with synthetic PNG/JPEG bytes and fixed waits. External browser requests are blocked.
- Three samples per phase/scenario, alternating baseline/candidate, candidate/baseline, baseline/candidate. Each sample uses a fresh browser context. Both built outputs were verified against complete 97-file SHA-256 proofs.
- Chromium 154.0.8037.57; 1280×1000 viewport, light theme, reduced motion. This is a small deterministic experiment, not a production capacity or p95 benchmark.
- First-visible time requires a decoded image intersecting the viewport on an animation frame. Settled time observes the final UI summary, excluding progressive pending summaries. Initial view asserts zero image attempts.
- An observation-only browser TransformStream forwards unchanged response chunks in both phases to measure headers and consumer-visible EOF. Download-window timings come from the injected downloader. Auth, sanitization, raster validation, encoding and rendering are included in end-to-end times; they were not separately profiled.

Median milliseconds (minimum–maximum):

| Scenario | Baseline first visible | Baseline settled | Candidate first visible | Candidate settled |
|---|---:|---:|---:|---:|
| small | 355 (347–359) | 361 (353–370) | 207 (193–214) | 221 (198–224) |
| many | 1868 (1860–1885) | 1874 (1870–1889) | 194 (187–199) | 963 (961–970) |
| slowFirst | 3008 (2994–3039) | 3017 (3007–3045) | 192 (186–199) | 2554 (2543–2559) |
| slowLastFailure | 3014 (2994–3036) | 3025 (3002–3046) | 203 (181–209) | 2712 (2699–2717) |

Scenario waits: `small` = 2×150 ms; `many` = 12×150 ms; `slowFirst` = [2500,150,150,150] ms; `slowLastFailure` = [150,150,150,2500] ms with the last image failing once. The failure scenario settles with three images and a retry action. See [raw measurements](bre-443-measurements.json) for headers, EOF, downloader window, counts and every sample.

Run the same experiment with a clean diagnostic baseline checkout and clean candidate checkout, frozen dependencies, Bun 1.3.14, Node 24, Playwright and Chromium:

```sh
bash apps/web/scripts/run-image-latency-comparison.sh /absolute/path/to/baseline /new/evidence/directory
```

The runner builds both commits, owns its two loopback fixture processes, and preserves sanitized failure logs. It does not attach to a mailbox or user browser. Build proofs, raw videos and screenshots remain in the evidence directory. The baseline harness must include `--image-latency` support from the diagnostic commit.

## Narrow implementation

Web opts into NDJSON on the existing guarded v2 POST. The API sends a sanitized placeholder template, validated image slots as they finish, and a terminal aggregate summary. Successful image data is sent once. The client replaces only generated image placeholders, preserving loaded images, focus and expanded history; an interrupted stream retains successful slots for a new explicit retry.

Two tasks per progressive request share a four-task semaphore with all legacy and JSON image work. Byte reservations are acquired before starting tasks; completed tasks are charged before more are admitted. The existing 12-attempt, 8 MiB total transfer, <2 MiB image, 20-second request, active-message, DNS/address-pinning, redirect, raster and serialized decoded-image bounds remain. Cookie origin/JSON guards, ownership and displayed-snapshot revision checks still execute before streaming. Cancellation removes queued tasks and the message lock remains until started work settles.

Older v2 servers can return JSON to the new web client on the same guarded route. There is no fallback to the legacy route. Source-bounded output positions beyond the existing selective-retry input range can display initially; the web reports a limit instead of sending an invalid retry. Request inputs retain their original bound. Older native JSON/legacy behavior remains sequential, with the original presentation hash and blocked-note semantics; the legacy route's existing stale-source limitation remains.

Parallel JSON alone would still hide healthy images behind one slow image. Sequential streaming would still block images behind a slow first candidate and would not reduce total time for twelve healthy images. The selected bounded two-task stream addresses both demonstrated cases.

## Verification and evidence

- Independent exact-executable review: no blockers; 43 focused tests passed. The earlier long-alt-text stream-cap finding was fixed and regression-tested. The reviewer rehashed both complete build proofs and checked all 24 sample records and video frames.
- Full-app light and dark image flows passed at the candidate executable: consent, stale refresh with new consent, partial/retry, no retained PNG refetch, repeat interactions, and cancellation while switching through the inbox. Component regression coverage also switches accounts during a progressive response.
- Inspected 19.08-second before/after MP4: `orca-web-images-before-after.mp4`, Library `libfile_ff32bde3bdd881918bb97f26342fda1d`, version 1; file `file_00000000b96881fdaaa0de0fe416b68b`, 665,159 bytes. Captions identify actual recorded run timings and baseline/candidate commits. SHA-256: `a33027f3a741b1721b741ff771a73ce1fcd6222a8bb0c93e16d93cbec96169a3`.
- The named Record Verified Demos skill could not be recovered in the current catalog/workspace; its earlier permanent installation was blocked. The supported recording workflow from the prior image demo was used, without installing anything.
- One intermediate measurement field was invalid because response completion had not been observed. A later Playwright `response.finished()` wait stalled in the full-app fixture. That run was stopped through its confirmed owned browser; failure logs and partial video were retained. Direct and independent synthetic API/renderer probes reached normal EOF. The final comparison uses bounded client chunk/EOF observations and all samples completed; the stalled run is not performance evidence.
- A test-only nullable expectation briefly failed typecheck during final preparation and was corrected before this executable's successful full-app builds. Applicable aggregate and hosted results will be recorded in the PR description.

## Remaining limits

The production Vercel-to-Railway proxy path and its chunk buffering are unverified for this new response, as are real sender DNS/TLS/download delays. Production first-visible improvement is not claimed. The live newsletter's cause remains unknown. Native runtime behavior of this web-only protocol was not tested locally; native clients retain JSON. No formats, redirects, services, cache scope, credentials, security settings, production data, migration, release or deployment were changed in this task.
