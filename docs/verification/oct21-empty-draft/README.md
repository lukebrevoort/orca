# October 21: intentionally emptied saved drafts

Base `b1d3c3e8f4e8c75c0b9d7a64ba458366784ef86c`; test-only red revision `e007d048e92168a6d043d81e158975b6cd10164b`; final executable `e863e1358358fba87afa1aee2f9480c511ea6d7a`.

Clearing To/Cc/Bcc, subject and body in a saved draft left its old content on the server. Reload during debounce also replaced the empty local checkpoint with that old content. Content-presence gates confused an intentionally empty saved draft with a new composer. Versioned checkpoints now participate in recovery, and existing server drafts accept empty updates. New untouched empty composers still make no remote mutation. No schema, API, layout or styling changes.

## Reproduction and verification

- [Baseline regression](baseline-regression.log): `bun test apps/web/src/compose-autosave-interruption.test.tsx`, 6 passed / 2 failed before product edits. Both failures retained.
- [Focused checks](orca-oct21-focused.log): 34 passed, 195 assertions across autosave interruption, account scope, and conflict tests.
- [Final browser evidence](passed/manifest.json): `python3 scripts/pstack/verify.py trial /tmp/orca-oct21-trial-final`, then `evidence ... --commit e863e1358358fba87afa1aee2f9480c511ea6d7a`, both exit 0. All 16 scenarios passed; 8 synthetic deliveries, no page errors. Existing recovery scenario now also clears all saved fields, closes/reopens, checks API contents, reloads and checks empty UI.
- [Light empty draft](passed/screenshots/light-cleared-draft-after-reload.png) and [dark empty draft](passed/screenshots/dark-cleared-draft-after-reload.png) visually inspected: empty subject/body/recipient controls, saved status and disabled Send. No control styling changed; this is not a new exhaustive contrast audit.
- [First browser attempt](failed-harness/checks.log), exact `99ccf36c9f60340ab57c800f30a392a39d32ca00`, failed cleanup because Discard is hidden for empty content. Reviewer identified this; final harness restores synthetic subject only after empty-state assertions/screenshot. No assertions weakened.
- Workspace typechecks and production build passed. Initial aggregate run: 1,561 passed / 1 failed in unchanged `attention-page.test.tsx:1201`, bulk-move Undo expected 2 rows, saw 0. Baseline/candidate targeted diagnosis and fresh aggregate results are recorded in PR verification updates; original failure retained.

Independent reviewer `/root/review` approved base through final executable after both findings were resolved (hidden cleanup control and initially ignored failure log). Independently ran 8 focused tests / 53 assertions on unchanged product/test sources. Dedicated empty-draft/newer-remote conflict test suggested as nonblocking future coverage; existing conflict/account suites passed.

Fresh loopback SQLite/API and browser profiles only; no live mail. Bun 1.3.14, Node 24, system Chromium (version recorded in browser-results); pinned browser download not exercised. Linux cannot run native checks: existing hosted CI is the verification path. This bounded compose sweep is not a whole-app clean claim. No held PR files modified, merge, deployment, migration, credential change, or workflow dispatch. Owned trial processes/scratch cleaned by runner; sanitized evidence retained here.

Targeted unchanged attention-page suite passed on both immutable baseline and final executable: 46 tests / 598 assertions each. This did not reproduce the aggregate failure and does not establish its cause. A fresh aggregate run follows with no browser trial running; its result will be recorded in the PR.
