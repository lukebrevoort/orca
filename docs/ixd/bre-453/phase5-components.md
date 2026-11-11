# Foundation component contracts

Status: proposed component/library contracts for BRE-454–457. Phase 4 inventories all 16 surface families. These contracts describe implementation obligations, not existing APIs or verified product behavior. Visual color/family values belong to Phase 6; use the existing Orca semantic token names rather than a parallel theme system.

## Tokens and structural defaults

| Role | Token/contract | Structural value |
| --- | --- | --- |
| Main text / page | `--orca-ink`, `--orca-paper` | Semantic colors; values in Phase 6 |
| Secondary / boundaries | `--orca-muted`, `--orca-border` | Semantic colors; values in Phase 6 |
| Surfaces | `--orca-surface`, `--orca-surface-hover` | Default and selected/hover surface roles |
| Accent / danger | `--orca-accent`, `--orca-danger` | Never the sole state signal |
| Type families | `--orca-font-display`, `--orca-font-body`, `--orca-font-reader` | Family values in Phase 6; code keeps a monospace role |
| Spacing | shared spacing scale | 4 / 8 / 12 / 16 / 24 / 32 / 48 |
| Radius | controls / grouped surfaces | 8 / 12; pills only for concise filters/identity |
| Targets | touch / compact pointer controls | At least44 CSSpx/pt touch; compact pointer variant may be36px with clear focus and adequate spacing |
| Reader measure | main text column | Comfortable cap around72ch; semantic table overflow stays contained and reachable |
| Motion | existing `--orca-motion-*` and easing roles | Fast140ms, ordinary180ms, writing transition no more than320ms; reduced motion removes nonessential animation |

These are layout defaults, not fixed native text sizes or permission to prevent zoom. Native Dynamic Type and platform safe areas take precedence over copied web dimensions.

Phase6 supplies the final semantic values: Ink `#132b24/#edf4ef`, Paper `#f7faf8/#111914`, Muted `#53665d/#acbcb1`, Surface `#ffffff/#19251d`, selected/hover `#e8f1eb/#25392d`, Border `#c8d5cd/#3b5042`, Accent `#166248/#a6d4b9`, explicit accent text `#ffffff/#111914`, Danger `#9f3c35/#f2a19a` (Light/Dark). Body family is Sora with reliable local fallbacks; display/reader is Newsreader with reliable serif fallbacks. Use the detailed Phase6 reliability and rendered-verification obligations before claiming these values are implemented.

## Reusable responsibilities

| ID | Component | Responsibility and main inputs | Required states and boundaries |
| --- | --- | --- | --- |
| C01 | Foundation shell | Current owner/account, active surface, global search/Compose, Drafts, Settings and reversible Mailboxes disclosure | Loading/offline/reconnect; one current destination; readable long names; no stale owner data or covered final content |
| C02 | Mail filters and list | Explicit Important/All Mail meaning, authorized rows/cursors/count scope and preserved return anchor | Loading/empty/partial/error; All Mail permanent; filter never mutates placement/read state |
| C03 | Mail row | Contact identity, sender/subject/preview/time/read state, account context and importance control | Stable target identity; keyboard/select/bulk context; no overlapping targets or decorative badge stack |
| C04 | Importance choice | Server-owned effective snapshot, explicit target/scope, mutation intent and guarded receipt | Loading unavailable differs from Unreviewed; pending/committed/conflict/reconcile/failure; no client-derived importance |
| C05 | Broader importance review | Exact sender/account, actual matching scope/preview and precedence explanation | Explicit confirmation/cancel; no writes during preview; no address/domain/account generalization |
| C06 | Reader content | Authorized complete conversation, presentation/semantic structure, images/attachments and return context | Loading/error/overflow recovery; remote content consent; stable identity/scroll; no content loss or unsolicited fetch |
| C07 | Writing workspace | Existing draft/controller, recipients/body/format/attachments, presentation and source context | Existing save/conflict/recovery/permission/dispatch states; no second persistence model |
| C08 | Writing delivery region | Current save/delivery status, attachment rows, explanations and owned actions | One responsive footer flow; all pending/failure/validation states fit; no collision or pointer shift into Send |
| C09 | View authoring/review | Original definition/revision, deterministic seed/refinement, read-only preview and explicit save | Advanced no-op preservation, precise sender semantics/counts, dirty guard and duplicate-safe save |
| C10 | Preference/connection panel | Active Settings section, shared dirty account values, device choices, actual connection/capability state | All eight sections reachable; Save visible across section changes; permission/readiness/delivery distinct |
| C11 | Notification policy/status | Versioned owned device/account intent, actual permission/registration/support and explicit policy meaning | Important-only eligibility; truthful foreground/background limits; reminders separate; old updates cannot downgrade policy |
| C12 | Operational state / top layer | Current safe action, preserved work, retry/return target and shared modal ownership | One active layer; focus/inert/Escape contract; stale/ambiguous results are never success; feedback cannot cover content/actions |

Web and SwiftUI implement the same meaning through platform-appropriate components. Sharing a wire contract does not imply sharing DOM layout or reimplementing secure native storage in web.

## Importance data and mutation boundary

One server-owned module supplies effective importance, source/provenance and current mutation revisions to authorized list/thread projections. Web, native and notification delivery consume that result; legacy attention/routing and Human Signal do not independently derive it. Important retrieval uses All Mail's authorization/retention basis rather than the default Inbox/provider placement predicate.

Conceptual ready snapshot: account/conversation identity; effective Important/Not important/Unreviewed; explicit conversation choice or inheritance; conversation revision; contributing exact-sender preferences and their current revisions as needed. Availability is a separate loading/ready/unavailable state: missing metadata must not silently become a real Unreviewed judgment or an empty Important inbox.

Mutations carry a target in one authorized account, an explicit choice or removal, and an expected revision. Derive user ownership from the verified session, never a caller-supplied user ID. Default target is the conversation. Broader exact-sender mutation follows separate explicit confirmation. Preserve conversation overrides; participant inheritance follows D2's stable aggregate and must explain other contributing Important preferences.

Keep monotonic revisions across removal/reset, including tombstones, to reject stale initial writes and Undo after remove/recreate cycles. Immediate Undo restores only its exact acknowledged target/revision and prior explicit choice. Removing a choice inherits current preferences; it must not restore a historical computed aggregate. Reconcile ambiguous responses before showing success or replaying. An offline choice is not secretly queued or reported saved.

The UI labels scope and consequence in human language. Version IDs and raw routing/account identifiers remain implementation details; conflict copy says the choice changed elsewhere and offers a current-state review.

## State and concurrency ownership

- Scope async work by current session/account/target/generation. Abort or ignore superseded work; never install another owner's callback, toast, cache, receipt or notification.
- Do not remove a row from Important until acknowledged state supports it. Restore logical focus after a committed removal; pending/failure keeps reading available.
- Independently guard read state, provider placement, views, authorship and notification intent. An importance action has none of their implicit side effects.
- Preserve existing draft/autosave/dispatch ownership. A write acknowledgement for older content cannot mark newest writing saved.
- Notification dispatch rechecks the same effective importance and current policy at delivery, including correction/read/revocation/device-generation changes. Old-mail correction does not replay notification history.
- Counts carry known-total, shown/partial or unavailable meaning. Neither an omitted count nor a failed fetch becomes zero; no expensive total is promised without computing it.

## Interactive control states

Every changed control has readable default, hover, focus, active/pressed, selected and disabled states in both themes. Selected controls use the established surface-hover/border/ink treatment plus a label/indicator; never an assumed inverse-color hole. Disabled controls retain readable labels and an actual reason. Pending actions identify owned work and reject unsafe repeats. Destructive actions are separated and explicitly named. All menus/dialogs use the existing shared top-layer focus/inert/Escape behavior.

## Typography/loading reliability

Reuse coherent identity while making typography deterministic offline. Current third-party font import and prior screenshot font-readiness timeouts require a controlled baseline reproduction. Bundled appropriately licensed assets or deliberate local fallbacks must remove that dependency; record actual request/asset counts. No visual pass depends on an unexplained font-readiness bypass. Do not claim a speedup without paired measurements.

## Verification hooks and metrics

Behavior enters through UI controls; independent server/database/provider ledgers prove persistence and side effects. Prefer stable accessible names and real account/target identity over CSS snapshots alone. Record exact source SHA, process exit0 and full expected case counts; an empty failure array after interruption is insufficient. Capture/inspect theme/viewport/native text states and retain honest blocked/unrun stages.

Measure same-fixture primary-control counts, task steps, visible content geometry, request/query work and actual scenario/assertion counts. Use the existing dedicated reader/compose/search/native harnesses for their surfaces, not a generic screenshot as proof of all behavior. No permanent test merely mirrors a styling implementation; regression checks must protect the user-visible contract.
