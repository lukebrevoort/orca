# Mail reader UX: readable mail without losing the message

Status: proposed cross-surface direction, with a conservative web implementation for review. No production rollout or native implementation is included in this first slice. Independent of the inbox/composer mobile-web draft.

## Goal

Make common notifications, receipts, newsletters, and human replies comfortable to read in Orca. GitHub issue and pull-request notifications are the first stress case: prose, code, diffs, long destinations, quoted conversation, and repetitive service footers often coexist in one message. The foundation must help other mail without assuming that a sender label proves authenticity.

## Reading hierarchy

1. Return to the originating mailbox with the existing cursor and scroll position
2. Subject, participant summary, message count, and the current thread actions
3. Per-message sender name **and address**, time, recipients/details, unread context
4. The actual message: headings, paragraphs, lists, links, code/diffs, and data tables
5. Clearly labeled, reversible quote and service-footer disclosures
6. Attachments with truthful availability/loading/failure states
7. Reply, Reply all, and Forward using the existing original message data

Orca owns the frame and reading typography. Sender content remains recognizable and complete. Decorative sender marks do not assert verification. Service actions remain the links actually supplied in the message; do not invent a “View pull request” destination from a parsed subject.

## Shared interaction model

| Area | Web | Native iOS |
| --- | --- | --- |
| Sender identity | Show address alongside name; keep full sent/to/cc/bcc disclosure | Show address alongside name; add recipient/details disclosure from existing model |
| Readable HTML | Semantic typography; local horizontal scrolling for exceptional wide layouts | Responsive WebView document with matching heading/list/code/table rules and Dynamic Type |
| Alternative view | Formatted / Plain text when both returned bodies exist | Native-selectable text alternative independent of WebView success |
| Quoted history | Existing text quote disclosure remains; future HTML folding must retain the full subtree | Future explicit quote disclosure; never delete quoted content |
| Original | A future “Email layout” view means sanitized sender formatting, not raw MIME | Same meaning and same security policy |
| Images | Existing policy unchanged in first slice; a separate privacy review must add block/load controls | Keep remote images blocked by CSP; explain missing images before considering explicit per-message loading |
| Attachments | Preserve the current truthful “Details only” state | Keep authenticated downloads; add per-file progress and failure states |
| Navigation | Keep current chronological grouping and newest-unread jump | Keep latest-first order and latest-message reply target initially |
| Failure | Preserve loading, partial, retry, offline context, and body-unavailable copy | Add WebKit-load/process failure fallback without discarding the text body |

Plain text is an alternative, not necessarily the sender's original MIME part. The current API may derive it from HTML and collapse whitespace; label its limitations and never use it to silently replace structured HTML.

## First implementation slice: web reading foundation

- Extract message-body presentation into `reader-body.tsx`; it consumes the already sanitized API payload
- Keep formatted HTML as the default. Expose Formatted / Plain text only when both nonempty values exist
- Switching is local to each account-scoped message identity and does not mutate mail, reply source, or provider data
- Reuse existing plain-text quote detection and explicit reveal. Do not introduce HTML quote/footer heuristics in this slice
- Fix `pre > code` compounding relative font reductions (previously 18 × .75 × .82 ≈ 11.1px)
- Keep code whitespace intact and scroll it horizontally; preserve diff insertion/deletion markup
- Wrap exceptional sender widths in a named, keyboard-focusable horizontal scroll region so they cannot widen the whole app
- Avoid classifying layout versus data tables based on shape. Preserve their cells, authored spacing, headers, and contents
- Show full sender address; explicitly place header actions at narrow widths rather than allowing grid auto-placement collisions
- Use established semantic theme colors and visibly labeled pressed/focus states

### Deliberately separate next slices

1. **Native parity:** testable HTML document builder, responsive typography, text fallback, sender detail disclosure, and reader-specific simulator CI
2. **Remote image privacy:** isolated rendering policy, accurate blocked-image state, explicit per-message loading, and network regression tests. Do not silently add image fetching as a side effect of opening or switching a message
3. **Reversible HTML simplification:** exact quote/footer markers with confidence thresholds; unknown content stays expanded. Full sanitized message remains one action away
4. **Common notification enhancements:** only after generic rendering is reliable. Preserve every code/diff line and destination. Any recognized-service treatment must not imply sender authentication
5. **Long-thread scanning:** expandable earlier messages, clear unread boundary, and return/jump focus behavior, separately reviewed from body rendering
6. **API text fallback quality:** preserve block separators in HTML-to-text generation; isolate incoming rendering from outbound sanitization before changing their shared policy

## Source-grounded audit

Baseline: `d7789a324bd3f07e3593308f9588394829fc8e88`.

- `apps/web/src/styles.css`: pre and code independently reduce font size. Nested tables inherit body size after an earlier fix, but generated cell padding still accumulates in wrappers
- `apps/web/src/App.tsx`: HTML is inserted from the sanitized API response; only plain text has quoted-history disclosure
- `apps/api/src/index.ts`: providerHtmlPolicy removes active content, stylesheets, foreground/background colors, and certain hidden preheaders. It preserves classes, many inline sizes/layout properties, and remote image URLs. Table presentation roles are stripped. The same policy also sanitizes outgoing HTML
- `apps/ios/Orca/Mail/SafeHTMLView.swift`: nonpersistent WebView, content JavaScript disabled, strict CSP and external user-click navigation. Its stylesheet lacks code/table/heading handling; fixed sender dimensions can defeat body typography. Exact WebKit overflow/scaling requires simulator verification
- `apps/ios/Orca/Mail/ThreadView.swift`: latest-first messages and bottom reply actions exist. Named senders hide their email addresses, HTML always wins, and WebView failure has no text fallback
- `scripts/ci/fixture-check.sh`: iOS fixture job currently runs compose scope. Native reading scope omits the long-message test and is not run by this job

## Verification and release gates

Use only synthetic fixtures, never private messages or production credentials in this public repository or screenshots.

- GitHub-shaped notification: nested fixed-width tables, prose, preserved pre/code, insertions/deletions, long link, full footer
- Receipt: semantic headings, headers, amounts, and nested data cells remain readable and complete
- Human reply: quotes are explicitly recoverable, forwards remain available, plain-text markup stays literal
- Responsive widths: 390px and 1440px full matrix plus 320/720/721/760/761px header-breakpoint smoke cases in both themes
- Themes and scale: Light and Orca Black, standard and large reading sizes; native Dynamic Type including accessibility sizes
- Behavior: repeated toggles, missing alternatives after refresh, account/thread changes, keyboard scrolling, focus states, back/forward return, reply actions, and attachment availability
- Security: no sanitizer/CSP weakening; no new script execution or tracking-image fetch during tests. Hosted browser harness uses a new profile and blocks external requests
- Hosted fixtures replace only presentation fields in an authenticated synthetic API response; they test the production reader, not the API sanitizer. External fonts are blocked with all other external requests, so screenshots use system fallback fonts
- Production build, all workspace typechecks/tests/lint, independent renderer review, and actual screenshots. Passing build/typecheck is not visual QA

The first draft is reviewable only with its exact commit's CI and evidence attached. Full cross-surface redesign is not complete until native parity and the above release checks are verified.
