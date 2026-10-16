# Recover and discard writing

## Sub-features

Wait for account/draft initialization, retain writing when closing, discard explicitly, and recover a revision conflict without overwriting the remote draft.

## How to get to it (user POV)

Open Compose while account data is loading; later close/reopen, or resolve Draft recovery choice with Keep mine as a new draft.

## Driving it with Playwright

The harness gates account/inbox/draft responses and asserts no temporary-account editing controls or browser writes appear early. It uses the `Draft recovery choice` alert and `Keep mine as a new draft` button, verifies latest text and kept attachment in the synthetic delivery, and reads the original via `/v1/drafts/{id}` to prove its remote contents remain unchanged. Discard waits for the first autosave, then verifies deletion. Screenshots cover account-pending, draft-recovery-pending, conflict-latest-writing and discard states in both themes.

## Gotchas

Response gates and direct API conflict injection create synthetic preconditions; recovery itself uses UI. Missing seeded drafts or account routes are failures, not reasons to skip. Close is not discard.
