# P12 — Provider connection settings

## 1. Overview
Inspect and recover supported provider permissions, Gmail labels and Calendar access. Entry: P11 Connected accounts, permission failure or supported direct route; exit: Settings/origin or existing explicit provider consent. Covers CORE-02/03 and F05. Reuse existing auth/security flows; held OAuth/migration PR298 remains separate and no live OAuth is performed by this documentation.

## 2. Layout
Return/account/provider context → actual connection/scope status → available permission/reconnect/sync actions → relevant label/Calendar details → operational result. Desktop stays within Settings; narrow web stacks content/actions. Long scopes, addresses, errors and action footers must remain readable and scrollable.

## 3. Components
Provider/account identity; granted/missing permission summary; supported reconnect/authorization action; sync/retry state; Gmail label/migration entry where supported; Calendar free/busy availability; privacy explanation; pending/error/session recovery. Do not present unsupported provider integration as connected.

## 4. Behavior
Explain real scope and consequence before existing explicit consent. Return through current safe callback/session/native-handoff contracts; canceled or denied consent preserves a truthful connection state. Sync is separate from granting access, and label migration retains its own explicit review/action contract. Calendar explains free/busy-only access and does not imply event editing/booking. Never infer successful permission or migration from merely navigating back.

## 5. State machine
Loading → known ready/missing permission/disconnected/unavailable/error; explicit action → owned pending → verified status/canceled/failure/ambiguous outcome. Repeated callbacks/actions cannot apply another account's result or duplicate owned work. Offline/stale scope information is labeled and cannot authorize a consequential action. Session/account change rejects old callbacks and removes inaccessible detail.

## 6. Motion
Shared settings tokens and reduced motion. Keep pending/results anchored to their provider action. External-consent transitions preserve safe return context; no animated success before the server confirms actual status.

## 7. Data loading
Reuse existing authorized provider availability, granted-scope, sync, label and Calendar contracts, with bounded retry and owner-generation checks. Preserve current token/redirect/CSRF boundaries rather than introduce a new auth path. No private mail, credentials or provider calls are required for synthetic interaction validation; source status is not live provider proof.

## 8. Adaptation
Provider configuration is web in the inventory; mobile web must preserve all supported controls and safe callback return. Native retains its existing onboarding, status and reconnect/handoff behavior without claiming equivalent label/Calendar settings. Native redirect checks and physical-device consent need distinct authorized evidence; browser responsiveness is insufficient.

## 9. Walkthrough
Synthetic connected/missing scope/unsupported provider; consent start/cancel/denial/owned callback; repeated/stale/cross-account callback; sync pending/failure; label entry and separate migration result; Calendar privacy; offline/session expiry. Inspect light/dark narrow/desktop and global feedback collisions. Existing auth/security regressions remain mandatory; live OAuth/private-mail validation and held migration work are outside this preparatory task.

## 10. Micro-interactions
Action labels name the actual provider and required permission. Distinguish Connected, permission granted, synced and migration completed. Error copy preserves known choices and offers a safe retry/reconnect. Focus returns to the invoking setting after completion/cancel; secrets never appear in status or feedback.
