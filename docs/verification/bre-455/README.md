# BRE-455 / BRE-464 backend — running, independent and final gates pending

Important-only notification settings, eligible browser feed and APNs dispatch are implemented on the unchanged version-1 shared wire. Production web/native clients are owned by their separate workstreams. No live Gmail/APNs, OS display, native/device acceptance, merge, deployment or TestFlight result is established here.

Clean checkpoint `3842e2918886454e0a3bf20796110eb1877c3907` passed **81 focused tests / 1,155 expectations**, API typecheck, and the [actual TCP HTTP/SQLite synthetic demo](demo-3842e291-result.json). It made **7 authenticated loopback HTTP requests**, one synthetic APNs attempt/delivery and one browser envelope; its one constructor report is explicitly simulated, with **zero actual browser constructors or OS-display proof**. The external provider network call count is zero. [Receipt](checkpoint-3842e291.json), [focused log](focused-3842e291.log), [typecheck log](typecheck-3842e291.log), [demo log](demo-3842e291.log).

## Behavior and provenance

- Explicit account-owned/device-scoped adoption is separate from client-reported permission, token/session registration and server availability. Reads never adopt. Original command UUID reconciliation returns current/superseded settings without replaying old intent.
- New-message persistence records original ordered SMTP metadata evidence and arrival-time effective importance in its final transaction. Unknown/missing/contradictory/old/future evidence remains quiet with a retained reason. It never upgrades old mail on routine sync. Eligibility uses the public batched `readImportance` result, independent of authorship, Inbox, saved views or placement; current state is checked again before delivery.
- Exact primary-account recipient evidence and coherent receiving/internal/server time support ordinary provider-observed SMTP arrivals, including archived/moved Important automated mail. This is not cryptographic SMTP proof, a complete alias catalog or reliable API-import detection. Indistinguishable forged imports cannot be excluded by this capability. See [evidence contract and limitations](implementation-notes.md).
- Freshness boundaries cover adoption, re-enable, permission restoration, new account selection and token/session replacement. Identical saves/registration preserve pending work. Persistent fifteen-minute account/conversation/installation cooldowns suppress additional arrivals permanently, without a delayed-batch promise.
- APNs reuses encrypted tokens, unique ownership transfer, generation barriers, leases, stable APNs IDs and bounded retries. Current permission/policy/session/account/importance/read/direction/freshness and lease authority are rechecked after token decryption, immediately before I/O. Ordinary OS priority/Focus applies; there is no app quiet-hours scheduler. Already-dispatched OS work and ambiguous external responses retain unavoidable races; a stable APNs ID is not an exactly-once OS guarantee.
- Browser claims have at most 20 plain metadata envelopes and a 30-second lease. Lost-response retry preserves IDs while eligible; constructor reports are idempotent terminal reports, never display proof. Clients must independently guard actual Notification permission, current owner/request generation/accounts and dedupe IDs before construction. Open-app scope has no service worker or closed-browser delivery.
- Unadopted installations preserve the existing placement policy. Adoption invalidates legacy outbox work. Older token-registration clients preserve adopted intent and previous selection, including obsolete legacy Spaces; they cannot downgrade or re-enable the policy. Manual reminders remain separate.

## Historical failures and standalone BRE-464

The original authenticated missing-route HTTP404 failure at `29e345e3c8943acc68e884d68dacd302c8a5c3a4` proves only that route was absent; later assertions were unreached. [Original receipt](baseline-red.json).

The stronger clean pre-dispatch regression at `101c45221f7ce1e452b5b9c4da3c86af69eb00f8` ran the unchanged legacy scheduler against an adopted Important-only installation: **one unwanted Unreviewed-human synthetic attempt/delivery**, expected zero. [Raw red](ledger-red-101c4522.log), [receipt](ledger-red-101c4522.json). The same test passes with zero attempts/deliveries in the wired checkpoint. Parent BRE-454/BRE-461 results are historical dependencies, not this patch's passes.

The first wired checkpoint `6b51113049178ece0b8b8894679b173fb3d9e691` had **54 pass / 1 fail**, plus five type errors; these remain [failed runtime](focused-6b511130.log) and [failed typecheck](typecheck-6b511130.log) evidence. Investigation reproduced real authenticated nonempty-account DELETE HTTP500 on the unchanged <=0053 parent schema, independent of notification tables/triggers. [Diagnosis](account-delete-parent-red.log). Final focused tests also reproduce the failure on **<=0051**, so this evidence does not attribute introduction to importance 0052/0053.

BRE-464 fixes the email-label deletion revision trigger: its insert now joins a still-existing account parent during disposal. Invalid FK writes still fail; ordinary label deletion and thread-delete/recreate revision barriers remain tested. Stable importance migrations 0052/0053 are unchanged.

Final order is standalone `0054_account_disposal_revisions` (`1791907200000`) followed by feature `0055_important_notification_policy` (`1791993600000`). Installed parent0054 → feature0055 → repeated no-op is tested. Historical unpublished checkpoints used reversed filenames; their receipts are retained as historical, never relabeled. See [migration-order record](implementation-notes.md).

## Reproduce

Use Bun 1.3.14 and frozen dependencies. Coordinate the shared heavy slot before runtime work; never nest the wrapper.

```sh
python3 /tmp/orca-ui-heavy-slot.py /opt/homebrew/bin/bun test apps/api/src/notifications apps/api/src/mobile-push apps/api/src/importance
python3 /tmp/orca-ui-heavy-slot.py /opt/homebrew/bin/bun run --cwd apps/api typecheck
python3 /tmp/orca-ui-heavy-slot.py /opt/homebrew/bin/bun apps/api/src/notifications/demo.ts /tmp/bre455-demo-NEW
BRE455_SQL_WORK_PATH=/tmp/bre455-work-NEW python3 /tmp/orca-ui-heavy-slot.py /opt/homebrew/bin/bun test apps/api/src/notifications/work.test.ts
python3 /tmp/orca-ui-heavy-slot.py python3 docs/verification/bre-455/sql-work-replay.py /tmp/bre455-work-NEW
```

The demo requires a clean committed checkout, creates its own loopback server/database/authentication, injects only the external APNs transport, and stops only its owned server/files. The SQL harness captures actual bounded statements/bindings and replays them against the exact pre-claim snapshot for deterministic SQLite VM work. It reads no message bodies for importance/notification eligibility and makes no universal speedup claim.

Full sequential workspace lint/typecheck/test/build, independent correctness/security review, final parent-drift verification and integrated client runtime gates remain pending at this checkpoint.

## Rollback

Do not run a legacy-only scheduler for adopted installations: reverting only new code could resume old placement interruptions. An operational rollback needs an explicit adoption/dispatch plan while retaining receipts, cooldowns, legacy selections and migration history. The independent parent-disposal fix should remain. No live rollback, merge, release or deployment is authorized by this draft.
