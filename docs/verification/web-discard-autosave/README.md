# Daily sweep: discard during the first web autosave

Baseline: `ab541c00d6e8dc23812d05004c0611fe9fd19c32` (October 11, 2026).

## Reproduction and root cause

Start a new synthetic web draft, let the 420 ms autosave begin its first POST,
then confirm Discard before the POST response arrives. Baseline discard checks
`serverIdRef` while it is still null, clears the editor, and reports success.
The POST subsequently creates a durable draft; no DELETE is issued. Reopening
Drafts can recover writing the user explicitly discarded.

`compose-account-scope.test.tsx` holds the first POST response. The new test
`discard waits for an in-flight first autosave and deletes the created draft`
failed against the unmodified baseline runtime with:

```
Expected methods: ["GET", "POST", "DELETE"]
Received methods: ["GET", "POST"]
5 pass / 1 fail / 26 assertions
```

Only the regression test was added before this RED run. All data and fetch
responses were synthetic; no live mail/provider was contacted.

## Fix

Discard stops debounce and polling, drains the existing save sequence, then
uses the returned server ID for deletion. An operation token fences account
changes, unmounts, and late DELETE success/failure. Writing, delivery, conflict
resolution and duplicate discard are blocked while deletion is pending. The
editor is inert and the existing Discard control says “Discarding…”. Failed
DELETE retains the local writing and permits retry. An unconfirmed first save
cannot be called a successful discard. A draft-list response started before
discard cannot restore the deleted draft afterward.

Regression coverage includes pending debounce, initial POST, late DELETE
success/failure, account changes during both waits, failed deletion and retry,
concurrent send/discard, stale list hydration and uncertain first-save failure.
The existing compose browser fixture adds the real synthetic API/SQLite race
in light and dark themes, with default, hover, focus and pending screenshots.

## Scope and validation limits

The sweep first inspected #237/#239 reader changes and ran 18 reader/navigation/
sanitizer tests (90 assertions), all passing. Open PRs #238, #235, #227, #224,
#190 and #55 were checked; none covers this web discard race. The native draft
fix was already merged; native source is unchanged here. No remote-image
prototype work, production mutation, credential change or deployment.

Local verification: 1,434 tests pass (730 API, 609 web, 95 shared); workspace
typecheck, lint, production build and API smoke all pass. Independent correctness
review found no blockers. The final immutable review and publication/hosted-CI
status are recorded in the sweep handoff and draft PR, if publication succeeds. Local browser
installation was blocked by the download host's HTTP 403 “Domain forbidden”;
visual evidence must come from the existing hosted fixture workflow. No local
browser or native UI pass is claimed by the hook tests.
