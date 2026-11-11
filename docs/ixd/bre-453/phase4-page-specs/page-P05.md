# P05 — Compose, reply and forward

## 1. Overview
Dependable writing on web and iOS, using the established durable draft and dispatch contracts. Entry: global Compose, Drafts, reader reply/reply-all/forward. Exit: saved close, verified send-return, explicit discard or Zen on web. Covers F02 and CORE-01; preservation is mandatory during shell simplification.

## 2. Layout
Account/context and close → recipients → subject → message format/body → formatting/attachments → one coherent status/delivery region. Inline reply retains conversation context. A constrained panel must scroll its writing content and keep every recipient/action reachable; mobile keyboard/safe-area changes cannot cover the editor or delivery controls.

## 3. Components
From/account identity; To/Cc/Bcc input and pending recipient text; subject/body; Plain/Rich choice with recognizable formatting labels; attachment add/remove/progress; saved/pending/failed state; send/discard; permission/conflict/recovery surfaces; optional web Zen switch. Apply saved defaults only to new writing, not over existing drafts.

## 4. Behavior
Keep one draft/controller meaning across panel, inline and Zen presentations. Pending recipient queries and attachment edits survive transitions. Plain text explains unavailable formatting; attaching remains possible when supported. Validate pending recipients and permission before sending. A repeated Send or replay cannot dispatch twice. Explicit discard waits for owned pending persistence and removes only its draft. Successful send returns to the correct source with focus; uncertainty retains writing and a clear reconciliation path.

## 5. State machine
Loading/recovering → editable → saving/saved. Conflict and failed save preserve latest writing and expected revision. Send validation → dispatching → verified success or uncertain outcome. Account/session changes remove inaccessible surfaces and reject stale acknowledgements. Close/leave is safe only when its draft state permits it; otherwise use the existing explicit decision flow. No fake scheduled-send/Later affordance is added.

## 6. Motion
Use shared tokens and reduced motion. Writing focus and selection are preserved across presentation transitions. Feedback is immediate and readable; animations cannot expose or activate the background beneath a modal.

## 7. Data loading
Use existing owned draft, recipient, attachment, autosave and synthetic-provider-tested delivery contracts. Keep latest local writing separate from acknowledged remote revision. No speculative success or automatic replay after ambiguous dispatch. Authorization and provider permission remain explicit and account-bound.

## 8. Adaptation
Panel/inline/mobile/native retain semantic parity for supported actions. Formatting labels wrap rather than become unrelated glyphs. Recipients and long filenames wrap without colliding with status or Send. Respect native accessibility text and keyboard insets. Zen-specific geometry is P06, without a second persistence implementation.

## 9. Walkthrough checks
Existing complete compose browser/API and native fixture suites, plus panel/inline/Zen transitions, pending recipient query, multiple/long attachments, plain/rich formatting, delayed/failed/conflicting saves, explicit discard, reload recovery, double Send, uncertain delivery, permission/session rejection and source return focus. Independent provider-call counts distinguish synthetic dispatch from real delivery. Verify final integrated revision.

## 10. Micro-interactions
Status distinguishes saving the newest writing from an older acknowledgement. Disabled controls explain why; every active control has a readable label and visible focus. Attachment removal has an owned pending state. Uncertain delivery copy never invites an unsafe duplicate send. Close/escape acts only on the current top layer.
