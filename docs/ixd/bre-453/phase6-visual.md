# Orca visual direction — quiet correspondence

Status: proposed foundation visual system, following the complete interaction inventory. This refines Orca's identity around readable correspondence rather than adding decorative dashboards. Token calculations are not a rendered accessibility or product pass; implementation screenshots and all control states still require verification.

## 1. Color

Keep one restrained green accent, paper/ink surfaces and distinct semantic error/warning colors. Contact signatures retain their existing identities and do not encode importance by color alone. Reuse Orca token names across the new shell rather than layering another competing theme system.

| Token | Light | Dark | Meaning |
| --- | --- | --- | --- |
| `--orca-ink` | `#132b24` | `#edf4ef` | Primary text |
| `--orca-paper` | `#f7faf8` | `#111914` | Page/reading background |
| `--orca-muted` | `#53665d` | `#acbcb1` | Readable secondary text |
| `--orca-surface` | `#ffffff` | `#19251d` | Controls/grouped surfaces |
| `--orca-surface-hover` | `#e8f1eb` | `#25392d` | Hover/pressed/selected surface |
| `--orca-border` | `#c8d5cd` | `#3b5042` | Quiet dividers; never sole focus/state indicator |
| `--orca-accent` | `#166248` | `#a6d4b9` | Links, focus and restrained action emphasis |
| `--orca-accent-ink` | `#ffffff` | `#111914` | Explicit text paired with accent action background |
| `--orca-danger` | `#9f3c35` | `#f2a19a` | Errors/destructive consequence |
| `--orca-warning` | `#805900` | `#e6c376` | Actionable warning |

Calculated text contrast for seven essential pairs in each theme: primary/page14.29/16.02; muted/page5.83/9.02; muted/surface6.13/7.99; primary/selected13.02/11.04; accent/page6.95/10.86; danger/page6.30/8.82; action-text/accent7.30/10.86 (Light/Dark, ratios to1). All fourteen calculated pairs exceed4.5. These calculations cover these exact opaque tokens only, not every rendered combination, opacity, image or control boundary.

## 2. Typography

Retain the distinctive existing Sora/Newsreader identity with deliberate fallback, rather than add a new font family. Web UI: `--orca-font-body: Sora, "Avenir Next", "Segoe UI", sans-serif`; display/reader: `Newsreader, "Iowan Old Style", Georgia, serif`; code uses a true platform monospace stack. Implement these through appropriately licensed local assets or reliable local fallbacks, eliminating the current external font import and unexplained screenshot font-wait bypass. Asset/source/license choices are implementation evidence, not completed work here.

Web defaults: UI/body15px with comfortable line height; navigation/actions14px; secondary metadata no smaller than13px; list subject16px; reader body18px/1.65, Large22px; page headings around28–32px and section headings20–24px. Keep one clear title, not a giant date/marketing hero above mail. Truncate only previews with an accessible complete label; full message content and action meanings are not truncated away.

Native uses Dynamic Type text styles and platform-appropriate font behavior; web sizes are not hard-coded SwiftUI point sizes. Preserve semantic HTML/code/table content and fallback glyph coverage. Actual rendered readability, large text and font failure/offline cases remain acceptance tests.

## 3. Iconography

Use the existing coherent outline icon family at a consistent optical weight. Pair unfamiliar or consequential actions with short visible labels. Importance, Move, read state, saved views and reminders have distinct names/icons. Do not substitute clock/arrow/diamond glyphs through CSS for unrelated functions. Touch targets remain at least44px/pt; icons can be smaller within that target. Native uses suitable system symbols with accessible labels.

## 4. Imagery and identity

Mail content and contact signatures supply the visual character. Keep Orca's wordmark and deterministic contact identity; avoid decorative illustrations, large empty hero art, background animation or new remote image/font requests. Empty states use a short explanation and a useful next action. Email images remain blocked until the existing explicit consent path allows them.

## 5. Layout and density

Use a quiet navigation rail and one focal reading/list column. Default primary exposure is Mail, Drafts and the global Compose/search/Settings utilities; Mailboxes discloses useful saved organization. On narrow web and native, preserve the same meanings through compact navigation and a single content column. All Mail recovery stays direct and cannot be hidden.

Rows use clear sender/subject/preview hierarchy and restrained separators rather than a stack of dashboard cards/badges. Reader content gets available width and a comfortable measure; genuine data-table overflow is contained and accessible. Settings shows one active section, not every field at once, with shared account Save and all eight section entries preserved.

## 6. Surfaces and elevation

Use solid paper/surface colors for reading and controls. Reserve elevation for actual temporary top layers, with one active modal ownership contract. Avoid background blur or translucent overlays behind text where they reduce predictability. Writing footer, attachment/status/actions and global feedback have reserved geometry rather than independent fixed elements competing for the same region.

## 7. Control states and accessibility

Selected/pressed controls use `--orca-surface-hover`, `--orca-border` and `--orca-ink`, with a label/check/indicator as appropriate. Do not create assumed inverse-color holes. Default/hover/focus/active/selected/disabled/pending/error states remain readable in both themes. Focus uses a clearly visible accent/ink ring with adequate separation; decoration alone is not the focus indicator. Primary action text uses the explicit paired accent-ink token. Disabled labels retain readable contrast and a real explanation.

Keyboard/VoiceOver order follows reading order. Menus and dialogs restore logical focus; committed filtered removal picks a surviving target or recovery control. Respect zoom, reduced motion, safe areas and native accessibility text. Calculate and inspect actual composed colors in implementation, including overlays and opacity.

## 8. Page-family annotations

| Family | Visual priority | Exception/preservation |
| --- | --- | --- |
| Mail / views / search / Drafts | Readable rows and named scope | Importance filter differs from provider placement and view retrieval |
| Reader | Complete message content | Preserve meaningful email formatting/tables/privacy; no snippet-only replacement |
| Compose / Zen | Writing and safe delivery state | One responsive footer, readable attachments/status; no phantom Later |
| Settings / connections | One current task and persistence scope | All section/deep-link entries, dirty guards, provider/security distinctions |
| Advanced Organization | Precise authoring/evidence when requested | Retain existing expert workflows, not the default triage experience |
| Auth / orientation | Supported next action and safe return | Existing security/consent/handoff boundaries; concise foundation explanation |
| Summary / Later | Actual supported content and return time | Coordinate real capabilities; no invented reply obligations or delivery |

## 9. Dark mode

Dark mode is an intentional low-glare ink surface with readable labels and content, not a blind inversion. Preserve the same hierarchy and semantic meaning as Light. Treat incoming email styles through the existing safe renderer; do not weaken sanitization or indiscriminately invert meaningful content. Test every changed control/state and representative mail in both themes. Native follows supported appearance preferences and platform accessibility behavior.

## 10. Motion and feedback

Use existing bounded fast/ordinary/writing tokens. Feedback is immediate; loading/error states remain visible and are not hidden behind animations. Avoid endless decorative motion, recurring fades on selection or font-driven layout jumps. Reduced motion removes nonessential transitions. Reader/list anchors and input focus remain stable across updates, and the current top layer alone handles Escape.

## Visual verification boundary

The architecture alternatives were inspected at728px Light and390px Dark. That proves the sketches rendered, not this complete visual system or application behavior. Final phase7/application demos must apply these values, inspect all relevant themes/viewports/text sizes, exercise actual interactions and record quantitative outcomes. No speedup, native shipment or real-mail acceptance is claimed by this document.
