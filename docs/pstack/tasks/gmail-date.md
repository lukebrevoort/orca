# Gmail timestamp recovery pilot

- Intent / playbook: `bug-fix`; malformed provider dates must not abort a batch, and fallback timestamps must be revisited systematically without deleting mail.
- Owner / independent reviewer: `/root/pilot_scope`; `/root/pilot_review`; design review `/root/workflow_review`. Separate agents, model diversity not claimed.
- Status: **running — final hosted verification pending**. Updated 2026-10-16 UTC.
- Base: `2d104ea394cc319c085d8983d2c17a923c2be467`; branch `fix/pstack-gmail-date`; isolated worktree `/workspace/orca-pilot`; [PR #251](https://github.com/lukebrevoort/orca/pull/251).
- Scope: Gmail normalization, bounded date recovery through existing sync paths, synthetic regressions. No UI/schema changes or overlap with PR #235 performance, PR #248 workflow, or merged #249/#250 features.
- Workflow dependency: followed repository-owned procedure in PR #248; product branch is independently based on main.

## Acceptance and outcome

The original guard prevents RangeError for malformed or out-of-range dates. Original [red](../../verification/gmail-date/red-tests.log), [green](../../verification/gmail-date/green-tests.log), [review](../../verification/gmail-date/review.md), and final 1484-test/typecheck logs in that directory describe executable `c970faf7cb4caea9b389de1bd5c35d4e65fba45e`, not the expanded recovery revision.

That guard alone did not guarantee repair: checkpoint-filtered reads can omit older messages indefinitely. Recovery now selects unknown dates and legacy ambiguous epoch dates using existing nullable `internalDate` and a versioned digest. Empty incremental/history paths perform read-only provider requests. Genuine epoch dates are retained; failed attempts rotate fairly with a cap of 20 per drain, shared across pagination/watch renewal. Only dates, attempt order, snapshot invalidation and derived thread date/subject change. Account, lease, provider identity and concurrent-snapshot checks protect writes.

Final executable revision: `83eaf9f228d7a2599f04ee8adf2bfccc61d979e4`. Independent review approved with 56 focused tests passing. All workspace typechecks passed. First full suite: 1499 passes, one unrelated web Undo-receipt failure under investigation; preserved without rewriting. See [recovery evidence](../../verification/gmail-date/recovery/README.md) and [review](../../verification/gmail-date/recovery/review.md). Current hosted status is maintained in PR #251, avoiding evidence-only CI churn.

Tests use temporary migrated SQLite, synthetic provider responses/tokens and two accounts with colliding provider IDs. They assert preservation of bodies, labels, attachments, read state, counts and Organization values, including stale-lease/concurrent-repair behavior. No live provider/mail writes, credentials or persistent database migrations. Test fixtures close owned connections and remove only their temporary directories. Worktree and evidence remain available.

UI evidence is not applicable to this provider-only task. Recovery requires recurring successful sync opportunities and eventual valid provider timestamps; it cannot invent a correct date while upstream remains malformed. Failed requests never delete messages. The bound limits provider request count, not elapsed request time or database scan cost.
