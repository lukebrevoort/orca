# P03 — Full conversation

## 1. Overview
Read complete mail comfortably and act with preserved return context on web/iOS. Entry: Mail, search, saved view, supported deep link or native notification. Exit: originating context, reply/forward/compose, attachment or an explicitly activated external link. Covers F01/F02/F05 and READ/CORE requirements.

## 2. Layout
Return/source context → subject and account → sender/recipient/time information → chronological message content → relevant actions. Earlier-history/details/quotes remain contextual disclosures. The body owns the primary reading column. Reply controls may use a platform-safe inset, with enough reserved scroll space to read and interact with the final content. Feedback/jump/navigation chrome occupies a separate non-overlapping region.

## 3. Components
Readable subject; contact identity and actual address details; account context; importance choice; separate Move/organization action; formatted/plain body; quote/history controls; explicit images; attachment actions; reply/reply-all/forward; long-thread jumps; operational and oversized-recovery states.

## 4. Behavior
Open full content and the appropriate unread/latest position using existing stable reader identity. A later mailbox refresh cannot remount the reader or reset scroll. Importance has P01's explicit account/conversation meaning and separate sender confirmation; it cannot move mail or imply reply completion. Reply actions retain real recipients/account/context. Link activation is deliberate; no remote content loads just from opening the message. Preserve chronological and semantic content order and the ability to recover quoted/original content.

## 5. State machine
Owned loading → ready or retryable error. Remote images remain blocked until explicit consent; changed source requires new consent and stale responses cannot populate another message/account. Long/oversized content has a truthful supported recovery path rather than a truncated success state. Importance and attachment operations have independent pending/error states. Session rejection removes inaccessible content and writing. The reply composer follows the durable draft state machine.

## 6. Motion
Use shared tokens and reduced motion. Avoid transitions that fade active labels or move text while being read. Expanding a quote/history section retains focus and a useful scroll anchor. Context jumps respect reduced motion and their target is visibly/focusably identifiable.

## 7. Data loading
Authorize account/thread identity and preserve existing bounded read/overflow contracts. Ignore stale generations; cancellation must not install prior content. Keep sanitization, CSP and resource blocking. Reflow only API-marked presentation structures; meaningful data tables retain semantics and accessible contained overflow. Never fetch external images or links to calculate layout.

## 8. Adaptation
Use available width for body text while retaining comfortable line length. Dense newsletters and nested tables must not create page-wide clipping. Native standard/accessibility text, mobile narrow/short viewports and web zoom retain content/actions. No overlay may cover sender details, importance choice, the body end, reply actions or attachments. Coordinate PR303 reader width rather than duplicate it.

## 9. Walkthrough checks
Representative plain, quoted, forwarded, newsletter, GitHub/table-heavy, receipt and long-thread fixtures; full content and link order; hostile HTML and zero unsolicited remote requests; image consent/retry/source change; attachment errors; earlier history and unread/latest jumps; delayed refresh/reopen/back; importance persistence/isolation; reply with dirty draft; account/session changes. Inspect before/after light/dark and appropriate native accessibility evidence. Keep oversized recovery limitations explicit.

## 10. Micro-interactions
Importance feedback uses the actual committed choice and provenance. Details disclosures explain real senders/recipients without replacing the readable main hierarchy. Error/retry copy describes what is preserved. Focus returns to the invoking row/search result on exit; Escape closes only the top layer. Contextual feedback stays outside critical reading/action regions.
