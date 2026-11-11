# P14 — Later and manual reminders

## 1. Overview
Return to a conversation at an explicitly chosen time and manage that reminder. Entry: P03 Remind me, supported Later/tool link or existing reminder; exit: reader, Later or origin. Covers NOTIFY-04 and preservation of D5/F04. Manual reminders are independent from new important-mail interruptions and automatic reply-review suggestions.

## 2. Layout
Later: account/title → actual reminder state → scrollable scheduled/resurfaced items and supported actions. Reader editor: conversation/account → delay/time and timezone → independent notification choice → Set reminder/status. Desktop uses contextual disclosure; mobile web stacks controls without covering the reader end or reply actions.

## 3. Components
Actual return time/timezone; existing delay/custom-time controls where supported; Notify me choice; Set reminder; Done/Cancel/Snooze where supported; scheduled/resurfaced states; load/retry/pending/error. Preserve supported Later visibility/preferences without adding a phantom Later/send-scheduling action to compose.

## 4. Behavior
Only explicit Set reminder saves a chosen return time. Done completes that reminder; Cancel cancels it; Snooze explicitly changes its return time under the existing contract. None means replied, archived or Not important. Notification preference is intent, separate from in-app resurfacing and actual OS delivery. Preserve current useful behavior while labeling unavailable delivery; no permission request solely from opening Later. Do not turn a read receipt into an automatic follow-up reminder.

## 5. State machine
Loading → scheduled/resurfaced/empty/error; editing → saving → acknowledged or recoverable failure. Finish/cancel/snooze have owned pending/result states and cannot duplicate or overwrite newer operations. Offline/stale time/status is labeled and not silently queued as saved. Account/session changes reject delayed results and clear inaccessible reminders; timezone changes must retain the actual saved instant and understandable display.

## 6. Motion
Shared disclosure/list tokens and reduced motion. Time adjustments and pending feedback stay stable; action positions must not shift a pointer from Snooze/Cancel into another consequential action. Closing returns focus without hiding a failed save.

## 7. Data loading
Reuse existing reminder schemas, ownership, scheduling and finish contracts. Counts describe the loaded reminder scope. Compare persisted status/time independently from OS delivery evidence. Source inspection found web reminder Notification API delivery unimplemented; a checked Notify me preference is not delivery proof. D4 Important-only cooldown/eligibility does not silently replace the manual reminder contract.

## 8. Adaptation
Web supports the inventoried Later/reminder tools; responsive web retains all supported labels/time inputs/actions. Native reminder parity is not established: preserve any actually supported entry, otherwise give truthful availability rather than add inactive controls or claim native notification delivery. Both themes, keyboard/zoom and any native accessibility text must keep times and action meaning readable.

## 9. Walkthrough
Choose time/timezone → save → reopen/reload → resurface → Done/Cancel/Snooze as supported; zero/invalid delay; failed/stale/repeated writes; daylight/timezone display; account switch; empty/offline/error. Verify unchanged importance/read/reply/placement state and separate denied/unavailable notification versus resurfacing states. Inspect light/dark mobile/desktop and global-feedback collision. These are pending checks, not results.

## 10. Micro-interactions
Show exact return time before commitment and actual scheduled/resurfaced status afterward. Pending Save/finish names the owned operation; errors retain chosen time. Confirmation never says notification delivered or conversation answered without independent evidence. Announce list removal/status changes and restore useful focus.
