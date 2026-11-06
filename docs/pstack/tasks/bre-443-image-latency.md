# BRE-443 web image latency

- Intent / selected playbook: perf-issue; measure synthetic image latency, then make a narrow supported improvement.
- Status: **running**
- Base: 2f4b2f8 (current main); branch codex/bre-443-image-loading-latency; /workspace/orca-image-latency.
- Acceptance: matched repeated small/many/slow/failure full-app measurements; click-to-first-visible and settled time; phase breakdown; preserve consent, auth/origin, SSRF, byte/count/time/decode/concurrency limits and cancellation; independent review, final tests and inspected demo; draft PR only.
- Excluded: real mailbox/sender/CDN, new formats or redirects, caching or services, #295 and #298, merge/release/deployment/migration.
- Owner: root; independent reviewer pending. One implementation owner avoids shared renderer/protocol races.
- Next: baseline current renderer and full built app with injected synthetic image downloader; retain measured logs before changing product code.
- Demo skill: unavailable in current cloud/executor catalog and repository skill folders; personal-context lookup unavailable. Deliverable prerequisite reported; diagnosis continues.
- Verification and review: pending.
