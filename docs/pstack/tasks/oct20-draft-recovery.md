# October 20 draft mirror recovery

- Status: **running** — local verification and independent review passed; draft publication and automatic hosted checks next.
- Intent/playbook: bounded bug-fix sweep. Recover a missing provider draft without losing local writing or creating duplicate copies when an edit overlaps recovery.
- Base: `0029a5d25126c36c88b22af1c9497e0127aefe40`.
- Failing regression: `c9652b5594e8fd7789e5d0cd229249f25f19ee36`; production code unchanged from base. Synthetic update 404 fails with nonretryable rejection, while four other status controls pass.
- First candidate: `e3a5a193ce9cb024e31dbcb83032397493776eac`; independent review reproduced two provider creates during a concurrent edit, so publication was held.
- Final executable commit: `524d74d16902a5938bf423f4c450d83778d09ca7`.
- Branch/worktree: `fix/oct20-deleted-provider-draft`, `/workspace/orca-oct20-sweep`.
- Ownership: provider transport and two focused regression files; only the stale-revision carry-forward hunk in `createApp` → `scheduleDraftMirror` is changed in index.ts. Parent checked PR235's complete patch, confirmed only inbox metadata-search changes and explicitly cleared this scheduler hunk. No other reserved search/reader/evidence-export files changed.

## Root cause and behavior

The active Gmail transport normalizes an existing draft update's 404 into failure and retains the obsolete provider ID. Later edits retry that ID. The legacy helper's recreate behavior is not used by the active provider path. The fix recreates only after a confirmed `GmailApiError` 404 from updateDraft, using identical MIME, token and reply-thread input. Other errors are propagated.

If editing advances the revision during recreation, the scheduler now carries the replacement ID forward only when the stored ID still matches the job's prior ID (including null). Draft-state and send-idempotency guards remain intact; newer content and revision are not overwritten.

Impact is provider mirror failure, not lost local writing. A baseline API fixture confirmed the latest body/subject remain editable and durable across repeated failures. Live Gmail deletion was not tested; external deletion is one possible reason for the simulated missing-resource response.

## Evidence and verification

All logs are in [the evidence directory](../evidence/oct20-draft-recovery/).

- `before.log`: **4 pass, 1 fail**, new 404 recovery regression before product edits.
- `review-race.log`: **0 pass, 1 fail** on first candidate; one replacement expected, two created.
- `baseline-impact.log`: **1 pass**, real baseline API/scheduler with stub provider; two old-ID updates, latest local content retained, mirror failed.
- `final-tests.log`: **23 pass, 0 fail** on final executable commit, seven files covering direct recovery/error controls, concurrent creation/recovery edits, threading, MIME, late mirror receipts, send preparation, and draft account isolation.
- `final-typecheck.log`: API typecheck exit 0 on final executable commit.
- `independent-final-tests.log`: reviewer reran **10 pass, 0 fail** on final executable commit.

Commands (Bun 1.3.14, frozen-lockfile dependencies):
```
bun test apps/api/src/providers/gmail/draft-recovery.test.ts apps/api/src/providers/gmail/transport.test.ts apps/api/src/providers/gmail/mime.test.ts apps/api/src/draft-mirror-recovery.test.ts apps/api/src/draft-mirror-delivery.test.ts apps/api/src/delivery-preparation.test.ts apps/api/src/mobile-drafts.test.ts
bun run --cwd apps/api typecheck
```

Independent reviewer `/root/review_limited_sweep` (model not reported) reviewed exact base through final executable head. Original P2 race finding was acted on; re-review approved draft handoff with no remaining blockers. Review is not merge authorization.

## Limits and cleanup

Temporary synthetic SQLite databases, synthetic encrypted token values and stub provider operations only. No live OAuth/mail calls, production migrations or credential/security setting changes. Fixture databases removed and no persistent test services started. Retained original reproducer and impact harness in `/workspace/scratch/orca-oct20-sweep`; permanent concurrent-edit regression is committed.

No UI change: screenshots not applicable. No browser/native or live Gmail pass claimed. Replacement-create failure and process-crash recovery are not newly covered. Existing automatically triggered hosted checks must still be inspected on final PR head; none manually dispatched. No merge/release/deployment authorized.
