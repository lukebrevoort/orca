# BRE-447 combined verification

The coordinator combines the reviewed BRE-448/451 Settings head `bf89ce778bed8703c19db9dad0255e8766a5e04d`, BRE-449 navigation head `792af6f15a22ebe350adec8f84c0d30cf0bbd350`, and corrected BRE-450 composer head `b7543689b6c3d2e1c5b7be3022a743c4dc3cda7c` into PR306. Their commit ancestry and individual evidence remain intact. Base: `9ec3ca31afecc28a4af2bf8b40c48a5f1fb9a311`.

This integration avoids serial base-drift CI cycles and tests the actual combined product. No earlier component pass is presented as a combined-revision pass. Final SHA/results are recorded in the PR and each result file.

## Reproduce

Start one owned loopback Vite server from the committed candidate, for example port5197. Use existing Node24, Bun1.3.14 and locked Playwright dependencies. Run one browser/check process at a time, with fresh output directories:

```sh
node apps/web/scripts/ui-audit-integration-e2e.mjs http://127.0.0.1:5197 /tmp/orca-ui-combined-new
node apps/web/scripts/compose-toolbar-e2e.mjs http://127.0.0.1:5197 /tmp/orca-toolbar-combined-new
node apps/web/scripts/settings-review-e2e.mjs http://127.0.0.1:5197 /tmp/orca-settings-review-combined-new
BASE=http://127.0.0.1:5197 EVIDENCE=/tmp/orca-settings-demo-combined-new SHA=<final-sha> PW_TEST_SCREENSHOT_NO_FONTS_READY=1 node docs/verification/bre-448-bre-451/settings-e2e.mjs
BASE=http://127.0.0.1:5197 EVIDENCE=/tmp/orca-settings-regression-combined-new SHA=<final-sha> PW_TEST_SCREENSHOT_NO_FONTS_READY=1 node docs/verification/bre-448-bre-451/auditor-regression.mjs
MOBILE_CURRENT_URL=http://127.0.0.1:5197 MOBILE_CURRENT_OUTPUT=/tmp/orca-navigation-combined-new PW_TEST_SCREENSHOT_NO_FONTS_READY=1 node apps/web/scripts/check-mobile-current.mjs
```

The new combined journey covers Settings → mobile More → All Mail → Stay, settled editor focus, repeated navigation → explicit Leave without a second native prompt, and returning to Inbox with one current marker, in both themes. It independently checks retained input, enabled Save, URL, focus, navigation attributes and zero API writes.

Existing focused journeys retain their original scope: six toolbar cases, eight authorization cases, six settings-preservation cases, 32 mobile section landings, and 96 navigation assertions. Inspect actual outputs and screenshots before claiming any passes. Screenshot font-readiness bypass remains a limitation of the indicated demo drivers, not a product fix.

Run full relevant lint/typecheck/tests/build on the final revision, with heavy local work serialized or hosted. Obtain fresh independent combined-diff correctness/security review. Validate pushed SHA and integration/base drift before merge. Hosted native checks remain separate from responsive web evidence; synthetic delivery is not real provider delivery. BRE-452 tracks the known separate Zen attachment/status collision.

Rollback the integrated change by reverting its merge while preserving the original branch evidence. No live mail, credentials, sending, release or deployment is part of these fixtures.
