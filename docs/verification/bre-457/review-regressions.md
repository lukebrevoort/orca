Independent review follow-up: BRE-465, BRE-466, BRE-467, BRE-468

The initial review findings are static evidence at b180ae4349e7b7d2c5f758afd2104e1b1ead1a40. They are not executed native failures. Root's two selector corrections (BRE-467, efcb60552771fbfd223c1c0e8bbef05589b73936) were normal-merged before this checkpoint. Root owns the existing PR313/PR310 hosted jobs; this work does not dispatch duplicates.

Before logical fixes, the native saved-view persistence logic and inbox loading logic were extracted into production Core controllers without changing their command/cache behavior. The SwiftUI editor delegates to that same controller. `MailActionJSON` moved unchanged into Core so the executable controller harness can compile without the entire UI. This refactored checkpoint is a new baseline, not runtime proof for the original b180 binary.

Prepared checks (execution pending an allocated cooperative heavy slot):

- `python3 /tmp/orca-ui-heavy-slot.py python3 apps/ios/Tools/ReviewRegressions/run.py /tmp/<new-owned-result-directory> --api`: production Importance, Inbox and NativeViewEditor controllers, actual APIClient/CacheStore; synthetic URLProtocol for dropped importance acknowledgement, cross-conversation reconciliation and known stale Undo; actual loopback Hono/SQLite for committed saved-view create with deliberately replaced acknowledgement, edit/retry/reopen and independent view counts. The runtime AppState in this harness is a fixture data owner, not the iOS application.
- `python3 /tmp/orca-ui-heavy-slot.py python3 apps/ios/Tools/ReviewRegressions/runner-lifecycle.py`: executes the actual hosted runner selection and phase code with synthetic Apple commands and durable adopted-policy namespaces. This verifies orchestration, not SwiftUI/APNs delivery.

The API harness owns its temporary database, session, loopback listener and cleanup. Provider calls throw and are counted. No live mail, simulator, Xcode build, adoption reversal or foreign history cleanup is involved. Exact SHA, source hashes, compile log, regression output and actual API ledger are retained on execution. No red/green runtime result is claimed until those checks run.

Full hosted native/UI gates, before/after screenshot inspection, full workspace gates, corrected backend integration and fresh independent correctness/security review remain required. The inherited hosted unit failure at b180 is the two MCP ingestion cases owned by backend; it is not a native regression result. PR310 reader timeout diagnosis also remains root-owned.
