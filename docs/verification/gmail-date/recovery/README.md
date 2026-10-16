# Timestamp recovery development evidence

These logs are development runs against the worktree descended from `cb8a1e3463a337e463189373ba2b632a3b8c1353`; final committed-head verification and independent review are recorded separately by the task owner. All data, tokens and provider responses are synthetic. No provider writes or migrations outside temporary test databases occurred.

- `red.log`: original six recovery regressions before implementation, 0 pass / 6 fail.
- `green-initial.log`: same six regressions after initial implementation, 6 pass.
- `focused.log`: retained initial broader failure: old history fixture now makes one extra metadata retry for its missing date (126 calls versus old expectation125); Bun subsequently reported nested-test errors after that assertion. `typecheck.log` retains the initial narrow helper type error.
- `focused-fixed.log`, `focused-final.log`, `coordinator.log`, `focused-complete.log`: intermediate expanded regression runs, retained without alteration.
- `focused-accepted.log`: 56 pass, 0 fail across date-recovery, normalizer, normalizer-date-persistence, sync, push, sync-persistence and sync-runtime tests.
- `typecheck-final.log`: all workspace typechecks passed after runtime budget propagation. Earlier `typecheck-fixed.log` / `typecheck-complete.log` remain intermediate successful runs.

Commands: `bun test apps/api/src/providers/gmail/<file>.test.ts` with the seven files listed above (initial red/green runs selected only `date-recovery`); `bun run typecheck`. Runtime: Bun 1.3.14 using the repository's frozen dependencies.

The 20-message retry cap is shared across pagination and watch renewal within one coordinator drain. Unknown provider dates persist as nullable `internal_date` with the existing epoch rendering in `received_at`; confirmed epoch dates are distinguishable through non-null `internal_date` and a versioned snapshot digest. Legacy ambiguous epoch rows are revalidated once. Recovery uses read-only metadata (full-message read fallback for older clients), validates account/lease/provider/thread identity, rechecks the selected snapshot after the request, and writes only dates, attempt order, snapshot invalidation and derived thread date/subject. Failures preserve mail and rotate behind other candidates, including with a fixed clock. This promises progress during successful recurring sync opportunities, not provider availability or automatic correctness for permanently malformed upstream timestamps.
