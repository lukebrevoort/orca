# BRE-456 web foundation implementation

Status: running. This directory is implementation evidence, not the coordinator's acceptance map. All 33 foundation requirements retain their upstream verification status. No PR merge, deployment, native or real-mail acceptance is claimed.

The prepared baseline is `bdec28426de57b8833ae29743eef330f391f63cb`. Public importance contracts come from `packages/shared/src/importance.ts` and BRE-454; no client-local importance store or invented notification endpoint is used. The four November Space pages and complete BRE-453 specifications were read. D1–D6 remain coordinator working defaults, not asserted historical Luke approvals.

## Implementation coverage

| Surface family | Web implementation |
| --- | --- |
| P01 Mail | Important-first production entry, permanent Important/All Mail switch, retained All Mail and account scope. Direct conversation choices, current inheritance, separately previewed exact-sender changes, guarded transient Undo and ambiguous-operation reconciliation use real API schemas. |
| P02 Mailboxes | Reversible disclosure retains configured names/order/visibility, saved views, collections, user spaces, Focus and utilities. Explicit legacy URLs keep their meanings. |
| P03 Reader | Existing complete reader/controller retained. One-column table flow fits the reading measure without removing table semantics; multi-column tables and wide code scroll locally. Privacy, original/plain/quotes, images, attachments and recovery stay in the original flow. |
| P04–P06 Writing | Existing Drafts, panel/reply/forward and Zen controllers retained. Attachment identity, acknowledgement, recovery and rapid-batch boundaries corrected under BRE-463. Prior Zen geometry and bundled fonts retained. |
| P07–P10 Finding/organization | Existing deterministic search → preview → refinement → explicit Save, advanced round-tripping, view/space management, Glass Box/Tide Table and authority/revert workflows retained. Importance never calls Move or creates a rule. |
| P11 Settings | One active panel with eight direct index/hash/mobile choices; shared dirty state and account Save remain available across panels. Existing Stay/Leave/unload, failed-save and ownership guards retained. |
| P12–P13 Connections/auth | Existing provider/security flows retained. Gmail, Outlook's unsupported sync/send, Calendar free/busy scope and notification availability are explicitly described. No live credentials or OAuth exercised. |
| P14–P16 Utilities | Later/manual reminders, actual BRE-438 Summary capabilities, dedicated reading/attention preferences and legacy routes remain reachable. Read state is not reply evidence. |

BRE-455 is a real remaining dependency: its wire contract was not committed when this checkpoint began. This build does not enable Important-only browser delivery or invent permission/eligibility routes. Manual reminder intent is labeled separately from unavailable browser delivery. Final integration must implement the committed contract and rerun the integrated gates.

## Reproductions and current limits

Baseline build initially failed because this checkout had no dependencies. A necessary unchanged frozen-lockfile installation succeeded; baseline full build then passed.

- BRE-460: real production reader with the documented post-sanitization GitHub-shaped fixture reproduces `clientWidth=324`, `scrollWidth=1366` at 390px in both themes. This verifies web layout, not inbound sanitization. The initial candidate fits the region in the same two scenarios.
- BRE-463: real loopback API/SQLite fixture reproduces 25 visible attachments versus serialized sets of 49/50 after recovering a draft whose server attachments were absent from the visible set. Initial candidate cap comparison passes; expanded 0/1/24/25/overlimit, byte/identity/reload and interrupted tests are still pending.
- BRE-462: three controlled baseline sequences settled correctly (plain/rich, held real acknowledgement with intermediate edits, and empty-body format change). The exact historical Bold/mousedown/screenshot/mouseup → Plain probe now passes four real-API cases (Light/Dark × 1440/390) on the dirty candidate. No no-op save-status production patch was made; this is a current non-reproduction, not a claimed historical fix.
- Initial broad web unit run: 773 pass, 92 fail, 5,282 assertions across 865 tests. These are not successful checks. Failures exposed old default-route/navigation expectations plus a real same-batch text/attachment race. Source and fixture corrections reduced the focused suite to 249 pass/two deferred-attachment recovery failures. Those recovery semantics were fixed without deleting assertions; the focused attachment/recovery suite now passes 14 tests/79 assertions. The entire UI suite must still pass before final verification.

## Commands

Use the existing absolute Bun 1.3.14 and Node 24.22.1 paths. Every heavy command runs through the cooperative nonblocking lock/resource sampler; exit 75 means not started and is never bypassed. One owned fixture/browser run at a time:

```sh
python3 /tmp/orca-ui-heavy-slot.py /Users/lbrevoort/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node apps/web/scripts/build-bre-456.mjs
python3 /tmp/orca-ui-heavy-slot.py /opt/homebrew/bin/bun test apps/web/src
python3 /tmp/orca-ui-heavy-slot.py /Users/lbrevoort/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node apps/web/scripts/run-bre-456.mjs apps/web/scripts/bre-456-regressions.mjs /tmp/bre456-NEW
python3 /tmp/orca-ui-heavy-slot.py /Users/lbrevoort/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node apps/web/scripts/run-bre-456.mjs apps/web/scripts/bre-462-noop-format.mjs /tmp/bre462-NEW
python3 /tmp/orca-ui-heavy-slot.py /Users/lbrevoort/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node apps/web/scripts/run-bre-456.mjs apps/web/scripts/bre-456-journeys.mjs /tmp/bre456-journeys-NEW
```

The runner starts only its owned disposable loopback compose fixture and closes it after the browser exits. The fixture uses actual API writes, SQLite and a synthetic provider ledger. The complete compose browser run passes 16 scenarios with eight provider invocations, 70 draft requests, zero page errors and zero external requests. Its navigation now explicitly opens All Mail before selecting the second-account reply target, preserving all original writing/ownership/delivery assertions. It cannot access live mail. Reader inputs explicitly distinguish post-sanitization rendering from API sanitizer tests. Font readiness has no bypass.

Full relevant lint/typecheck/test/build, the existing complete compose fixture (16 scenarios/eight synthetic deliveries), font positive/404 negative runtime checks, complete five-journey/16-family evidence, all changed control states, final parent integration, pushed-head verification and root independent reviews remain required. No performance speedup is claimed; measured work/counts and resource samples must accompany any later claim.

## Rollback

Revert the web implementation commits to the prepared parent while retaining server importance data/revisions and existing user drafts/preferences. No importance/schema/routing/provider migration is performed by this web change. Historical evidence and the parent's API/native work are preserved. Parent owns final independent review and merge authorization.
