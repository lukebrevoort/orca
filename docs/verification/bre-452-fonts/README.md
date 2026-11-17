# BRE-452 / BRE-456 web foundation evidence

Status: candidate browser matrix passed; exact final-head workspace and preservation checks follow this evidence commit. Root correctness/security review and the merge gate remain pending.
Full BRE-456 Mail/client rework remains pending; this slice owns only web Zen
layout, font delivery, its focused synthetic browser driver and this evidence.
No API, shared schema, native, navigation or importance semantics are changed.

## Baseline and reproduction

Prepared immutable product baseline: `fcb848c322e2948973d87a27b999fc3e1121ca8f`
(`origin/integrate/BRE-453-foundation-core`). Linear BRE-452 reports Compose →
attach toolbar.txt → Rich text → Open in Zen at 1440×1000 in both themes.
The baseline build and driver started before product edits, recording that exact
HEAD. The production fixture continued serving that build while source work
proceeded; it was not rebuilt until baseline collection ended. The original
driver is retained as `baseline/driver-used.mjs`.

Actual baseline result: exit 1, 92 recorded scenarios, 1,802 contract checks,
349 failures, 84 geometry measurements, 38 attempted external font requests and
zero font payload bytes received under the controlled blocking/stall conditions.
23 checks measured intersecting regions; 33 center hit checks failed; 256 targets
were below 44px. Both theme-specific external stalls failed readiness and normal
screenshots (two readiness failures and two screenshot failures). Nine checks
reported attempted external requests, including the aggregate guard.

Do not attribute all 349 failures to product defects: 12 paths attempted to reopen
Compose after Save & close had already returned to its panel, and 12 state paths
used a Playwright locator click on an intentionally aria-disabled validation
control. Those harness failures prevented baseline delivery/recovery completion;
they do not establish those features regressed. Candidate journeys use the actual
panel return and native keyboard validation. No baseline failure is relabeled pass.
The initial broad baseline was unnecessarily long; no second baseline matrix ran.
The baseline raw capture is retained at `/tmp/bre452-baseline-complete`; its
inventory/hashes and selected reviewer screenshots are committed here.

The driver uses the actual production build, loopback API/SQLite fixture, fresh
browser contexts and synthetic provider transport. Font-stall injection responds
to the product's actual Google Fonts import with controlled @font-face rules;
the referenced external font requests are held until an explicit test barrier is
released. Font-offline aborts font resources while loopback app assets remain
available; this is font availability testing, not an offline-install/PWA claim.
No live mail/provider traffic or credentials are used.

Geometry captures independent attachment/formatting/delivery/recovery regions,
checks intersections and horizontal overflow, scrolls each action into view,
checks its actual center hit target and 44px target size, and captures normal
Playwright screenshots after document.fonts.ready. No font-readiness bypass.
720×450 is the CSS reflow viewport corresponding to a 1440×900 window at 200%
zoom; it tests reflow, not native iOS or browser chrome magnification.

## Reproduce

Use existing frozen dependencies, Bun 1.3.14, Node 24 and provisioned Chromium.
Build the exact committed revision and launch an owned synthetic fixture:

```sh
python3 /tmp/orca-ui-heavy-slot.py bun run build
bun --no-env-file apps/api/scripts/compose-fixture.ts
# fixture prints the private connection.json path; never publish that file/token
python3 /tmp/orca-ui-heavy-slot.py /absolute/node24/bin/node \
  apps/web/scripts/zen-fonts-regression.mjs CONNECTION_JSON OUTPUT_DIRECTORY
```

For a baseline run, use unchanged baseline product source and append `baseline`.
That mode labels the report; it does not suppress assertions or change the exit
status. Expected failing baseline evidence must be retained, not counted as pass.
All heavy commands use the shared nonblocking OS lock, nice +10 and resource
sampling. Exit 75 means no work started. Loopback fixture servers may idle outside
the slot. Never nest the wrapper or bypass contention.

## Matrix

Light and dark; 1440×1000, 1024×768, 390×844, 320×568, 390×400 and 720×450 reflow.
Zero, one, multiple/long attachments, actual chooser/removal, Plain/Rich and
panel/Zen preservation. Pending, failed-save/Retry, saved, invalid recipient,
revision conflict/copy recovery, pending send and uncertain-delivery replay.
Cold/reload/font-offline/external-font-stall paths in both themes.

## Rollback and boundaries

Revert this slice's product commit to restore the parent typography/Zen CSS;
no database or stored draft migration is involved. Local font assets are passive
web resources. Root integration must rerun checks on its integrated SHA.
Hosted Apple/native verification is separate and is not claimed here.

## Candidate harness iterations

The initial candidate run at `08a69b229307b72eaca27d0c0654ebe8fc24145b`
was stopped by closing only its verified owned Chromium child after concrete
harness failures were inspected. Its partial results are retained in
`/tmp/bre452-candidate-browser` and are not a pass. It measured no overlapping
regions or external requests in its completed cases, but used mouse-mode
programmatic focus for a focus-visible assertion, an aria-disabled locator click,
and an attachment-limit case without a stable-save precondition. The next run at
`d4ca7275c8abeaf290611ded9daa5e0fc3831d2f` stopped at the first unexpected save
readiness failure; `/tmp/bre452-candidate2-browser` retains the actual failing DOM,
screenshot and report. Candidate matrix setup now establishes the initial saved
draft and waits for each format acknowledgement; deliberate pending/failure races
remain separate, explicitly gated state journeys. Existing compose fixtures and
timeouts were not changed.

The third iteration (`eac2f5817853cb99d478c9682d04ad0a8cacb85b`,
`/tmp/bre452-candidate3-browser`) confirmed successful draft API acknowledgements
but the UI stayed Saving after a no-op Bold → Plain toggle. This is a retained,
unresolved save-status probe, not a pass or a verified root cause. The controller
is unchanged by this slice. The functional formatting journey now types actual
rich text before returning to Plain and verifies its acknowledgement. This does
not establish the no-op save-status issue fixed; root review should track it
separately rather than infer complete controller acceptance from layout checks.

## Passing candidate and final-head handoff

At `d1e8751f78a1ca5bb046e72ce1a06cc025908df8`, the complete candidate driver
exited 0: **164 scenarios, 3,180 recorded contract checks, 134 geometry
measurements, 168 normal screenshots, zero failures and zero external requests**.
The 12 recovery/uncertain-delivery journeys each made exactly one synthetic
provider invocation, retaining latest writing and attachment bytes; replay did
not add an invocation. All 18 font cases completed normal document.fonts.ready
and screenshots without PW_TEST_SCREENSHOT_NO_FONTS_READY. Font-offline fallback
covers every target viewport in both themes. Cold/reload/third-party-stall cases
use 390×844; normal loaded-font geometry covers all six target viewports.

The built product source was `6dad0525afd351582dac62d94d07767ca2d6bd49`;
product files are byte-identical at the screenshot commit and this evidence
commit, with hashes in [manifest.json](manifest.json). Subsequent driver-only
changes use fixed-viewport screenshots (avoiding body content below a fixed Zen
surface in full-page capture) and retain synthetic HTTP error details. They do
not remove assertions or change timeouts. The final committed head must still
run the full workspace checks, unchanged complete compose fixture and focused
164-scenario driver; exact-head results will be retained under
`/tmp/bre452-final-checks`, `/tmp/bre452-final-compose` and
`/tmp/bre452-final-browser` and named in the draft PR. A product-equivalent earlier
pass is not substituted for that final execution.

Baseline and candidate font payload counts are controlled-network observations,
not an online CDN download benchmark. Baseline: 38 attempted external requests,
zero successfully received font payload bytes because those paths were blocked
or stalled. Candidate: zero external requests; two unchanged local assets total
**563,064 bytes per cold pair**. Across 32 cold pairs in the entire matrix:
**64 font responses, 18,018,048 payload bytes**, excluding HTTP headers/compression.
There is no speedup or latency claim. The candidate also contains two HTTP 400
responses during the bulk-capacity probes; those probes verify a truthful
capacity/disabled/remove flow and readable recovery state, not successful
25-file provider persistence. The final run retains error details for root
review. Intentional state probes also receive 12 synthetic 503s and 12 revision
409s. Complete compose/API preservation is a separate mandatory check.

See [screenshot index](screenshots.md), [candidate measurements](candidate/results.json),
[baseline failures](baseline/results.json), and [resource samples](resources.jsonl).
Exhaustive raw captures remain in the inventoried `/tmp` directories; selected
review frames are committed. Actually inspected before/after desktop and mobile
in both themes, plus focus, Plain disabled, capacity, short-height recovery,
uncertain delivery and offline fallback frames. This is responsive web evidence,
not native iOS acceptance. The final viewport-only captures are re-inspected
before delivery.

All heavy launches use the shared OS lock and nice +10. Resource records capture
before/after and 15-second global CPU/RSS and memory-pressure samples. They are
observations, not aggregate process-tree accounting or hard CPU/RAM ceilings.
The shared `/tmp/orca-ui-heavy-resources.jsonl` is unchanged. Contended launches
exit 75 without starting; no local simulator or separate competing heavy job was
started. Only this slice's owned browser/fixture processes are stopped; fixture
databases and credentials remain private and disposable. Logs and screenshots
remain retained after server cleanup.

Rollback: revert this slice's product changes (Zen markup/styles and local font
assets). No API/shared/native change or data migration needs reversal. Do not
merge this draft until root formal correctness/security review and integration
verification complete; full BRE-456 implementation remains pending.
