# P13 — Authentication, onboarding and native handoff

## 1. Overview
Reach the correct owned workspace through existing session/consent gates, with a concise orientation to readable mail and safe correction. Entry: launch without session, explicit reconnect, sign-in or supported native handoff; exit: valid original destination or safe Mail. Covers F01/F05 and CORE-03. Reuse authentication; this preparatory spec does not absorb held OAuth/migration PR298 or claim live consent was exercised.

## 2. Layout
Recognizable Orca identity → current sign-in/connection purpose → supported provider action → concise status/recovery. Orientation introduces Important, permanently reachable All Mail, conversation correction and separate Move/view meaning. Desktop and mobile web use a single readable column; native retains its platform session/configuration/handoff surfaces and safe areas.

## 3. Components
Supported provider availability; explicit sign-in/connect action; consent explanation; pending/canceled/error/retry; safe return context; concise optional orientation/continue; account identity after verified session. No fake account registration, unsupported provider connection or automatic notification permission prompt.

## 4. Behavior
Keep login, provider scope consent and notification consent distinct. Follow existing validated redirect/state/callback and native one-time handoff contracts; an arbitrary external return URL cannot become navigation authority. Continue only after current-session confirmation, honoring supported deep links and unsaved-writing recovery. Orientation explains proposed D1–D6 behavior accurately once implemented, without asserting AI learning, complete ranking or global undo. Sign-out/revocation clears inaccessible prior-owner surfaces.

## 5. State machine
Checking session → authenticated or sign-in required; explicit sign-in → pending → verified session/canceled/denied/error. Native handoff → pending → consumed/expired/rejected; repeated or stale callbacks cannot reopen an old identity. Offline checking offers a truthful retry without showing another owner's cached mail. Account/device change invalidates prior session/notification generations and pending protected operations.

## 6. Motion
Shared onboarding tokens and reduced motion; navigation is usable immediately. Do not animate a prior account's content behind login or a sheet. Focus moves to the verified destination heading or actionable recovery, and top-layer dismissal never activates the background.

## 7. Data loading
Use existing session/provider availability and validated handoff contracts. Preserve CSRF/state, allowed-return, expiry, token protection and ownership boundaries. Callback receipt is not proof that sync, notification registration or native delivery succeeded. Synthetic sessions/fixtures validate interaction without live OAuth, credentials or private mail.

## 8. Adaptation
Web responsive sign-in is not native authentication coverage. Native preserves secure storage, OS browser handoff and Keychain semantics; platform Dynamic Type/VoiceOver must retain action/error labels and privacy copy. Native app lifecycle/interruption and physical-device handoff require separate authorized verification. Both themes retain visible focus and readable pending/disabled controls.

## 9. Walkthrough
Synthetic new/expired/revoked session; sign-in cancel/deny/retry; valid versus external return; expired/replayed/mismatched native handoff; pending account switch/interruption; sign-out with protected work; orientation → All Mail → correction discovery. Inspect light/dark narrow/desktop, native accessibility text and feedback collision. Existing auth/security regressions remain required; live OAuth and device acceptance are unrun.

## 10. Micro-interactions
Copy names the actual next step and preserves safe return context. Pending controls prevent duplicate owned requests; errors offer retry without leaking token/identity details. Successful sign-in does not imply all providers are connected. Orientation is concise, keyboard-readable and does not obscure recovery or gate access behind irrelevant preferences.
