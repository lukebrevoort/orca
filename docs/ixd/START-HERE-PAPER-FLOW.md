# Start Here — Sketch the Orca Desktop Flow in Paper

**Status**: Ready for design exploration  
**Tracking issue**: [BRE-321](https://linear.app/brevoort/issue/BRE-321/redesign-every-remaining-orca-desktop-screen-around-the-new)  
**Reference prototype**: [phase7-prototype-desktop.html](phase7-prototype-desktop.html)  
**Product-direction authority**: [user-direction-review.html](user-direction-review.html)

## Assignment

Create one connected Paper document that sketches the complete Orca desktop experience around the approved Organization direction. This is a design exploration and flow map, not production implementation. Do not include mobile; mobile has its own future rebranding milestone.

## Read first

1. Open `user-direction-review.html` for the five approved decisions.
2. Click through `phase7-prototype-desktop.html` in light and dark themes.
3. Read `phase4-page-specs/page-P07.md`, `phase5-components.md`, `phase6-visual.md`, and `phase8-document.md` for behavior, states, components, and handoff boundaries.
4. Inventory the current desktop routes and surfaces in `apps/web` before drawing replacements. Record each current route, its source component, primary user job, and important states in the Paper document.

## Locked direction

- Trace and Audit are hidden by default in a contextual right drawer. Pinning is available only at 1280px and wider.
- Glass Box is the default rule view: a colorful, dotted-whiteboard construction surface with connected blue **When**, amber **If**, green **Then**, and purple **Because** pieces. Tide Table remains the deep text editor.
- Historical simulation stays compact beside the rule and expands for examples, conflicts, risk, and authority. Any edit makes it stale.
- Stable anchors are Inbox, Drafts, Organization, and Settings. Focus, Signals, Quiet, Later, and future user spaces are movable and user-owned.
- Desktop is the only approved platform for this work. Do not extrapolate the historical mobile prototype.

## Paper document structure

Build these pages or sections in order:

1. **00 — Principles and legend**: approved colors, type, spacing, component vocabulary, state notation, and open-question marker.
2. **01 — Application shell**: stable anchors, user-owned spaces, reorder/rename/hide/restore/create behavior, narrow desktop, and dark theme.
3. **02 — Inbox and attention home**: initial load, triage, selection, bulk actions, empty, loading, offline, and error.
4. **03 — Workflow spaces**: Focus, Signals, Quiet, Later, plus a user-created space and its management flow.
5. **04 — Search and all mail**: query, filters, results, no results, saved context, and recovery.
6. **05 — Reader**: reading, evidence/context, thread navigation, actions, and safe return to the prior list.
7. **06 — Composer and reply**: new message, reply, draft persistence, send, failure, retry, and discard confirmation.
8. **07 — Drafts**: list, resume, conflict/recovery, and deletion.
9. **08 — Organization**: discovery → Glass Box edit → simulation → evidence → activation → Trace/Audit → revert. Reuse the approved prototype instead of redesigning it from scratch.
10. **09 — Settings and accounts**: account connection, permissions, preferences, user-space management, and destructive confirmations.
11. **10 — Zen**: focused reading/writing entry, exit, and state restoration without inventing a separate visual brand.
12. **11 — System states**: loading, empty, no access, partial load, stale, offline, conflict, error, and recovery patterns shared across screens.
13. **12 — End-to-end flows**: connect the frames into the journeys listed below.

## Required connected journeys

- Triage an incoming message → read it → reply → return to the same list position.
- Create and reorder a workflow space → organize a message into it → hide and restore the space.
- Discover an Organization rule → edit in Glass Box → inspect Tide source → simulate → activate → explain an outcome → revert.
- Start a draft → enter Zen → recover after interruption → send.
- Connect or repair an account → understand a permission failure → retry safely.
- Go offline during a meaningful edit → preserve work → reconcile on reconnect.

## Drawing conventions

- Name frames `P## / Surface / State / Theme / Width`, for example `P05 / Reader / Loaded / Dark / 1440`.
- Use arrows for user navigation and labeled dotted connectors for background state changes.
- Place interaction notes beside the control they describe. Include keyboard and focus behavior where it changes the flow.
- Reuse a component instead of redrawing it. Mark intentional variants and state changes explicitly.
- Keep unresolved product questions in a visible parking-lot section; do not silently decide them.

## Completion checklist

- Every current desktop route/surface is present in the inventory and maps to at least one proposed frame.
- All six required journeys are connected from entry to completion and recovery.
- Every major surface includes loading, empty, error/offline, and no-access behavior where applicable.
- Light and dark themes are demonstrated, including narrow desktop behavior.
- Organization uses the approved Glass Box and evidence-drawer direction unchanged.
- Mobile frames are absent and labeled deferred in the document scope.
- The Paper share URL is added to BRE-321 with a short list of open questions and the next review checkpoint.

When these checks pass, request a user direction review before producing implementation tickets or production code.
