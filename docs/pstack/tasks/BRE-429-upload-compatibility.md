# BRE-429 Linear upload compatibility

- Status: **running**; final review/check results will be recorded in the draft PR description without another evidence-only commit.
- Intent / playbook: bounded bug fix; accept the exact `/uploads.linear.app/` bucket on `storage.googleapis.com` and forward the exact Content-Disposition header, preserving remaining URL/asset/header/redirect restrictions and the signed URL.
- Base: 397df0e01cf7d54a1292473fc50c039ad359107d. Branch: codex/BRE-429-linear-upload-compatibility. One implementation owner; independent review follows the immutable commit.
- Evidence: supplied sanitized production events identify upload_url_bucket, HTTP 200, upload_prepare on November 4 at 23:29:37 and 23:30:48 UTC. Supplied verified Linear CSP includes https://storage.googleapis.com/uploads.linear.app/. Production does not establish header failure or successful delivery.
- Public references: https://linear.app/developers/how-to-upload-a-file-to-linear requires copying response headers. https://github.com/linear/linear/issues/353#issuecomment-1652378929 gives Content-Disposition; https://github.com/linear/linear/issues/353#issuecomment-1652440163 explains filename preservation.
- Acceptance: exact bucket slash boundary, reject bucket/host lookalikes and arbitrary buckets, preserve protocol/userinfo/port/fragment/asset restrictions, preserve original signed PUT URL and redirect:error, forward Content-Disposition unchanged, reject nonstring/CR/LF/NUL header values and unauthorized header names, diagnostics exclude private data, no PUT/create after validation failure.
- Reproduction: new synthetic tests on unchanged main: 15 passed / 3 failed, exit 1 (`/tmp/BRE-429-compat-before.log`). Failures demonstrate old bucket rejection rather than live delivery.
- Focused post-change: 34 integration/route tests passed, zero failed, exit 0 (`/tmp/BRE-429-compat-focused.log`). Final committed checks pending.
- No UI changes: screenshots/local compose trial not applicable to this backend change; existing hosted Fixture Checks provide browser/API and iOS coverage.
- No production mutations, live Linear calls, feedback retries, credentials, Mac access, merge or manual deployment. PR #288 excluded. All fetches in tests are synthetic. No services launched; logs retained in /tmp/BRE-429-compat-*.
