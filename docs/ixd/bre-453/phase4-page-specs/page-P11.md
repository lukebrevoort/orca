# P11 — Settings

## 1. Overview
Make account, device, writing, attention and privacy choices discoverable with honest persistence. Entry: global Settings or supported section link; exit: origin/P12 connections/P16 preferences. Covers F04/F05, NAV/NOTIFY/CORE. This proposed rework preserves the original Settings Account Save-guard ticket and its verification obligations rather than treating this spec as its completion.

## 2. Layout
Coordinator working design: compact section index → one active section/panel → shared account-save region, avoiding a full-page wall of fields. All eight same-page/hash entries stay directly reachable: Account; Appearance & reading; Inbox & attention; Writing; Notifications; Connected accounts; Agent connections; Privacy & data. Mobile web uses a labeled section picker and stacked fields; native uses an appropriate platform Form/navigation structure. Explicit Save stays reachable even when the edited section is inactive; status/global feedback cannot cover it or final content.

## 3. Components
Scope labels; existing account/profile/signature/writing controls; device reading/theme/motion choices; organization links; separate important-mail policy and manual-reminder preferences; actual permission/registration status; provider/agent connection management; privacy/access/sign-out information; Save account choices and safe leave guard. Reuse existing security/connection controls.

## 4. Behavior
Device choices apply under their local contract; account choices require acknowledged Save. Section switches preserve all unsaved account choices in shared state without a leave prompt; only leaving Settings invokes its global protection. Preserve newest edits when an older save completes; don't mark them saved or let Stay/Leave lose them. Account fields stay locked until saved values safely load. D4 proposes Important-only new-mail policy with explicit intent/permission, fresh unread Important eligibility, no old-mail replay and one interruption per conversation/account/device per fifteen-minute cooldown; additional messages are suppressed. Respect OS quiet/Focus without claiming an app quiet-hours scheduler. Manual reminders retain a distinct chosen-time preference and capability explanation.

## 5. State machine
Account loading → editable/dirty → saving → saved or dirty-newer/error/conflict; active-section state is independent of shared account edits. Failed save retains edits; ambiguous outcome reconciles before replay. Dirty navigation/Back/repeated leave outside Settings uses one owned Stay/Leave flow; section/hash switching does not. Notification intent → permission denied/unavailable or registration pending/ready/error; preference/permission alone never means delivery. Owner/session/device change invalidates stale saves/registration and clears inaccessible data. Offline account writes never silently claim saved.

## 6. Motion
Shared settings/disclosure tokens and reduced motion. Section navigation leaves headings unobscured and focus usable. No save-bar movement or permission transition may conceal validation, activate background controls or obscure the guarded decision.

## 7. Data loading
Reuse existing account preferences, reader preferences, connection and notification contracts. Recheck current owner/device generation and eligibility at delivery; suppress ineligible queued work after correction/revocation. Preserve legacy notification config for rollback and specify compatibility so older-client updates cannot silently downgrade Important-only. Existing native APNs is placement-based; web reminder Notification API delivery is unimplemented. Neither proves the proposed new policy works.

## 8. Adaptation
Mobile web keeps all eight section destinations in its picker and shared account Save reachable. Native preserves honest per-control account capabilities, mailbox/local visibility, notification status, connection/sign-out and device privacy information; avoid a blanket read-only Account label or implied web-only account/agent parity. State Keychain/protected-draft handling accurately. Native Dynamic Type, web zoom and both themes must preserve labels, scope, permission explanations and destructive-action separation.

## 9. Walkthrough
Direct-link/hash/picker all sections; navigate explicitly to Writing before initial field edits in migrated regression tests. Edit → switch sections without prompt → save from another section; device versus account persistence; failed load/save; save then newer edit; dirty external Back/leave/repeated navigation; account switch/session expiry. Preserve original protection assertions. Separate important policy from reminders; denied/unavailable/foreground/background registration; queued correction, cooldown, read/revoked/stale owner and older-client compatibility. Inspect light/dark mobile/desktop, native accessibility text/privacy and global-feedback collisions. Original Save-guard regression and complete relevant checks remain unrun obligations.

## 10. Micro-interactions
Every choice states This device/Account/Provider scope. Save feedback says whether current choices are saved or newer edits remain unsaved. Denied/unavailable notifications offer the actual recovery path; no unsolicited permission request occurs on entry. Inline errors preserve focus and field values; toast/feedback never hides Save or Stay/Leave.
