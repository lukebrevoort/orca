# Narrow native query-plus review

Reviewer: independent Codex reviewer agent `/root/review_native_query_plus_dd00`; underlying model identity is not exposed to this agent. Applied the Orca `interrogate` rubric.

Reviewed immutable comparison: `1f6b453bb128c3c32c3306554b994f8e665f2a7e` → `dd00cb041c56f39efbd7a92c2e88e7d64677ec31` in `/Users/lbrevoort/.t3/worktrees/orca/t3-e7dbe952-6002d97f243ef88b` using `git show`, `git diff`, and `git grep`. Scope is the query transport fix and two diagnostic assertion changes only. Intended behavior: a literal plus supplied through `URLQueryItem` reaches the API as a literal plus, preserving exact sender results and all existing authority boundaries.

## Act on

None. No blocking correctness or security finding in this comparison.

- `apps/ios/Orca/Core/APIClient.swift:40–43`: rewriting raw `+` in `percentEncodedQuery` after assigning `queryItems` is appropriately narrow. It produces `%2B` for literal plus, preserves existing percent escapes, and leaves encoded spaces, Unicode, delimiters, repeated keys, nil values, and empty values to `URLComponents`. A literal input `%2B` remains encoded as `%252B`, rather than becoming a plus. An empty query remains nil. The transformation applies consistently to query names and values and does not modify path, body, headers, credentials, redirect policy, or retry behavior. The separate strict discard implementation remains unchanged; its account identifier is outside the reported plus case.
- `apps/ios/Tools/ReviewRegressions/SenderTransportDiagnosticCases.swift:55–66`: the replacement assertions retain server ingress query equality, literal decoded sender, status 200, exact expected owned row IDs, successful response decoding, and zero unexpected rows. This is stronger product evidence than requiring an unobserved response delegate callback. The direct `%2B` control stays independently constructed. The original production APIClient sender-row assertion remains unchanged at `NavigationBaselineCases.swift:83–84`; no-plus, space, literal-percent, account mismatch, DML, provider, and outbound-network controls remain unchanged.
- Server evidence binding is sound within this fixed sequential fixture: `navigation-fixture.ts:27–53` records only sealed loopback GETs with the exact account/view/key set and fixed synthetic sender allowlist. The original sender request precedes the direct control, and `server.count == 5` guards the expected request set. SQLite witnesses at `navigation-fixture.ts:110–111` are independent exact-address queries. No production authorization or account predicate changed.

## Consider

None required for this fix. Request-side delegate hook execution/rejection remains unverified, and the revised report explicitly preserves that limitation rather than inferring a cause from empty observations. The three-line production fix has a wider beneficial query-value effect, but this static review does not claim runtime coverage for every APIClient caller or every encoding edge case.

## Verdict

**APPROVED for this narrow patch, subject to the parent's final-revision verification gate.** This is an independent static correctness/security review, not a test pass, UI/native acceptance, Phase B approval, or permission to merge/release. No tests, compiler, browser, server, CI, or child agents were run; no source files were changed. The parent-reported baseline reproduction and ongoing frozen-head gate were context only and were not independently rerun here.
