# P06 — Zen writing

## 1. Overview
Web alternate writing presentation for the same draft/controller as P05. Entry: new writing preference or Open in Zen. Exit: saved close, return to panel/source, verified send or explicit discard. Goal: calm writing without losing recipients, attachments or delivery state. Covers F02 and BRE-452.

## 2. Layout
Simple return/save-close context → recipient/subject/body reading column → formatting and attachment region → one coherent delivery footer. Attachment chips, save status, explanation and delivery actions participate in the same responsive layout rather than competing independently fixed elements. Writing content and the last footer action remain reachable in short viewports and with the keyboard.

## 3. Components
The P05 recipient/body/formatting/attachment/status/send components, shared draft state and return context. No phantom Later label. No Zen-only send or persistence semantics. Optional word count cannot displace critical save/delivery information.

## 4. Behavior
Opening/closing Zen preserves pending recipient input, content/selection, attachments and errors. Send/discard follow P05 exactly. Footer regions wrap or stack coherently; adding or removing an attachment never obscures status or another action. Long filenames remain identifiable and removable. Escape respects the shared top-layer contract and returns focus/context safely.

## 5. State machine
Same durable P05 states, with presentation transition kept separate. Pending attachment, saving, invalid recipient, permission failure, conflict, dispatch and uncertain-delivery states must all fit the layout. Returning to panel cannot clear or hide the actual pending state.

## 6. Motion
Use shared writing-transition tokens and reduced motion. Preserve a peaceful transition and writing focus without animating independently fixed footer pieces. Do not delay access to a failure or confirmation behind the transition.

## 7. Data loading
Reuse the existing draft/controller and attachment lifecycle. No extra persistence request solely for entering Zen. Stale acknowledgements and account/session changes retain P05 ownership rules. Layout measurement must not trigger provider/network calls.

## 8. Adaptation
At narrow/short widths, use a readable stacked footer. Larger text/zoom, zero/one/multiple attachments, long names and validation explanations must not produce overlap or page-wide overflow. Native iOS has its own writing layout; this web presentation is not claimed as native coverage.

## 9. Walkthrough checks
First reproduce BRE-452 with the same synthetic attachment and measured intersecting regions. After fix, assert non-overlapping attachment/status/action boxes in both themes at relevant narrow/desktop widths and short heights; inspect actual screenshots. Repeat zero/multiple/long attachments, add/remove, plain/rich, invalid recipient, pending/failed save, conflict and send/uncertain states. Preserve full compose fixture scenarios and exact synthetic provider-call counts.

## 10. Micro-interactions
Formatting/attachment actions have recognizable labels and visible focus. Pending status remains associated with current writing. Footer wrapping is stable and predictable; no attachment removal button shifts beneath the pointer into Send. Save-close feedback matches the actual draft acknowledgement and returns to the right context.
