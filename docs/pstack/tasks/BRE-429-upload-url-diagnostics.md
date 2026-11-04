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
