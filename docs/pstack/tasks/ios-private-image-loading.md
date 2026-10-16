# Explicit iOS message image loading

- Intent/playbook: feature; let a person load remote email images explicitly for the current message while retaining default blocking and WebView network isolation.
- Acceptance: no image request on open; explicit warning/action; authenticated account-scoped resolution; HTTPS public-address pinned connections; bounded PNG/JPEG payloads/dimensions; redirects/private addresses/obvious pixels remain blocked; partial failure usable; no remembered consent or cached resolved HTML; stale responses discarded; synthetic native before/after evidence in light/dark.
- Owner: Homebase execution owner; independent reviewer `/root/verification_review` (model identity not exposed).
- Status: **running**.
- Base: `5baf7f3ea9e208001c607a7bc0f5c418fb056d58`; branch `feat/ios-private-image-loading`.
- Scope: API image route/downloader/sanitized rendering, shared availability flag, iOS explicit image action and regression tests. PR253 diagnostics, PR252 web reader isolation and PR235 search excluded.
- Before: API sanitizer removes every image including CID; iOS CSP permits local data/CID but forbids remote resources. Private fixture separately removed source resources; private bridge is demo-only and excluded from this PR.
- Privacy: all committed fixtures synthetic; private mail/assets/mappings outside Git. Explicit loading may reveal opening to the sender despite pixel filtering. No persistent sender policy; no arbitrary remote WKWebView access. PNG/JPEG only initially; CID/GIF/WebP remain blocked.
- Next: focused tests, immutable commit, independent review, actual native theme evidence, draft PR and hosted-check follow-up. Existing baseline has unrelated Focus-contract and refresh-idle blockers; do not claim full suite green.
