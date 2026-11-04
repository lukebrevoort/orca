# BRE-429 upload URL predicate diagnostics

- Intent / playbook: bounded diagnostic refinement (feature); identify the rejected upload URL predicate without upstream data.
- Acceptance: fixed parse/protocol/userinfo/port/fragment/bucket/host codes; same acceptance, rejection order, error message, asset restrictions and redirects; no PUT/create after rejection. Synthetic accepted forms retain original URLs.
- Owner: Codex /root. One implementation owner; independent interrogate reviewer after immutable commit.
- Status: **running** (2026-11-04 UTC).
- Base: d3be3c52a0fb905d830713060d74301e66f336ed; branch codex/BRE-429-upload-url-predicate-diagnostics; /workspace/orca.
- Scope: Linear integration, focused tests, this record. PR #288 excluded.
- Reproduction: supplied production evidence says upload_prepare / HTTP 200 / upload_url. No production access or reproduction attempted; this only refines diagnostics, not delivery.
- Privacy: synthetic fetch stubs only. Exact diagnostic object assertions exclude upstream URLs, headers, filenames, feedback, identifiers and credentials. Existing error message remains fixed.
- Focused initial check: 33 tests passed, zero failed; /tmp/BRE-429-focused.log. Final committed checks and review pending.
- UI: not applicable; no UI change. Hosted checks pending.
- Exclusions: no Linear calls, credential retrieval, login, production, retry, deployment, migration, merge or formal approval.

## Final code evidence

- Draft PR: https://github.com/lukebrevoort/orca/pull/290 (remain draft).
- Executable/test revision: `d56d8dea33f6574c9268006a0ad71dc7c18d2541`; subsequent task-record-only revision does not alter code.
- Independent reviewer `/root/independent_review` (model identity not independently exposed) reviewed the complete base-to-final diff; no blocking findings. Independently reran 33 focused integration/route tests with zero failures. Limit: synthetic only, no production verification. `/tmp/BRE-429-independent-final-review.log`.
- Final code checks: `bun run typecheck`, `bun run lint`, `bun run build`, and `bun test apps/api/src/integrations/linear.test.ts apps/api/src/feedback-ticket.test.ts` all exited 0. Focused: 33 pass / 0 fail. Logs `/tmp/BRE-429-final-{typecheck,lint,build,focused}.log`.
- Initial aggregate compiler checks failed on a synthetic fetch stub's type assertion. Fixed in d56d8de; final compiler checks above passed. Original logs retained as `/tmp/BRE-429-{typecheck,lint,build}.log`.
- Baseline differential: final integration tests against the original base implementation in isolated `/tmp/BRE-429-baseline` produce 15 passes / 2 expected failures (old generic reason). Accepted-URL cases pass on the base too. `/tmp/BRE-429-baseline.log`; no network fetches.
- Full local workspace test run and hosted checks still pending at this record commit; final results will be recorded in the PR description rather than causing another docs-only CI run. Do not infer review-ready from this checkpoint.
- GitHub CLI API read returned Forbidden; connected GitHub plugin successfully created/read the draft. Git transport push and remote-head verification succeeded without authentication changes.
- Relevant hosted workflows: Unit Tests and Fixture Checks. Native reader path-filtered workflow does not apply. Final-head run links/results and merge-ref SHA will be in the PR description.
- Evidence logs and isolated synthetic baseline retained under `/tmp/BRE-429-*`; no owned services launched. UI screenshots/local compose trial skipped because the changed surface is backend diagnostics; hosted Fixture Checks covers its existing synthetic browser/API and iOS paths.
