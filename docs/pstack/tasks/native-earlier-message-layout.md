# Native earlier-message accessibility layout

- Intent / playbook: native UI sweep; focused bug-fix for the known earlier-message control wrapping at Accessibility XXXL.
- Acceptance: readable complete words, 44pt hit target, correct expand/collapse semantics, ordinary-size and light/dark behavior preserved.
- Owner: Homebase /root. Independent reviewer pending.
- Status: **running**.
- Base: `0a9ecd6f9db027ce0cf6ede004311b2567e197fe`; branch `fix/native-earlier-message-layout`.
- Scope: ThreadView earlier-message label and matching native regression only. PR253 CI diagnostics, PR252 web fixtures, PR235 metadata search, web/API performance and release work excluded.
- Fixture: fresh current-main loopback mobile fixture with synthetic images; no live email or production service.
- Baseline: single-job unsigned simulator build succeeded. Accessibility label is 44pt wide / 385.67pt tall. Screenshots and AX evidence in Homebase `homebase-evidence/native-sweep`.
- Known separate issue: first Jump to latest alignment; not addressed by this patch.
- New observation: Inbox view picker label clipping at Accessibility XXXL; outside focused patch.
- Verification / final executable / review / hosted checks: pending.
- Constraints: one build/simulator lane on 8GB M1; preserve authenticated browser tabs; no merge, release, TestFlight, security or credential changes.
