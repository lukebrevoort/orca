# BRE-444: native digest width regression and scoped candidate

- Intent / playbook: regression-first investigation and bounded fix for narrow character stacks in the iOS reader.
- Status: **running**. The baseline reproduced the synthetic defect. The first candidate widened the header but left narrow statistics wrapping; this next scoped gutter-cell experiment awaits independent review and one new-head native run. Keep PR #303 draft and unmerged until verification is complete.
- Base: `faf41b80a1ec3149ee34d9782235c889023d59ea`; PR branch `codex/bre-444-native-width-diagnostic`.
- Ownership: implementation owner and independent source/test reviewer. Held PRs #295/#298 and PR #292–#295 descriptions/media remain untouched.
- Source: [BRE-444](https://linear.app/brevoort/issue/BRE-444/feedback-look-at-this-compilation-the-text-isnt-readable). Exact original email HTML and installed app revision remain unknown. No private content or screenshot is included in these artifacts.

## Confirmed synthetic baseline

`SafeHTMLView.swift` forces every table to `table-layout:fixed` and every cell to `width:auto`, including unmarked sender layouts. Empty cells in nested unknown tables receive equal fixed-layout shares instead of yielding width to content. An outer two-column wrapper followed by a three-column header reduces its content cell to roughly one sixth of the reader width.

The single [baseline Native Reader run](https://github.com/lukebrevoort/orca/actions/runs/42387346546) executed exact diagnostic head `647b1493e5e7f96e56bf16c6d75381358767f177` with unchanged product code on Xcode 26.4.1 / iOS 26.4.1. It compiled and ran WKWebView, with 163 tests passed, five existing scope skips, and only the new readable-width test failed. At reader widths 272/342/700, title content widths were 42/54/113 px and title line counts were 10/8/4. At 272/342, each three-digit statistic occupied three lines. The 272 case also failed the original cell-containment assertion. The document still fit its viewport at scale 1, showing why overflow alone missed this defect.

The [sanitized synthetic native artifact](https://github.com/lukebrevoort/orca/actions/runs/42387346546/artifacts/13579494870) contains identity, metrics and screenshots. `screenshots/Orca-79.png` visibly shows the narrow title and digit stacks at width 342 in dark appearance; independently inspected. Artifact ZIP SHA-256: `c7b36f9f4ec6f4bdfb5b8bc2435336caba106ca5ad77e1a9307d550e20911208`. Screenshot SHA-256: `d5a44fe21e52a600fb4750cf720b107ea52c383f5d6d601c5aff13180f5c930d`.

This proves the synthetic mechanism, not that the unavailable original message was exactly reproduced. No unchanged workflow rerun was requested.

## Fixture provenance

The fixture follows the unmarked spacer/header/statistics topology in public Discourse source at `444e62cc26e96c7da97f08fa45df219f03f60114`:

- [Digest wrapper](https://github.com/discourse/discourse/blob/444e62cc26e96c7da97f08fa45df219f03f60114/app/views/user_notifications/digest.html.erb)
- [Header](https://github.com/discourse/discourse/blob/444e62cc26e96c7da97f08fa45df219f03f60114/app/views/user_notifications/digest/_header.html.erb)
- [Statistics](https://github.com/discourse/discourse/blob/444e62cc26e96c7da97f08fa45df219f03f60114/app/views/user_notifications/digest/_stats.html.erb)

It is not a full Discourse rendering or a copy of private mail. All content and URLs are synthetic. The API test compares the Swift literal byte-for-byte with production sanitizer output.

## First candidate result

Exact head `6a3b223d898ad1b8c515f85bcef3f4876033605e` compiled and ran in [Native Reader](https://github.com/lukebrevoort/orca/actions/runs/42390301765): 163 passed, one failed (the same regression), five existing scope skips. The image light/dark job passed. Title widths improved to 256/326/680 px and title lines to 2/2/1 at reader widths 272/342/700. Statistics still occupied 3/2/1 lines. All 12 light/dark and body-size layouts retained aligned 2×2 statistics, caption/header semantics, cell containment, viewport width at scale 1, and blocked remote images. No original assertion was weakened.

[Candidate raw synthetic artifact](https://github.com/lukebrevoort/orca/actions/runs/42390301765/artifacts/13582355214), ZIP SHA-256 `2aa98d1bdcac72d8721035b7e4e5d05bfc105a4baf03311a795623515deb4c4f`: `screenshots/Orca-33.png` (272 light), `Orca-39.png` (342 light), `Orca-30.png` (342 dark), `Orca-58.png` (700 dark) were visually inspected. Independent evidence review confirmed the exact source tree and partial result. The body still occupies roughly the middle third even at 700 px. Nested full-width blank tables in its gutters, unlike the plain-empty header gutters, are the leading explanation; that candidate did not directly measure body/gutter widths, so the intrinsic-sizing detail was not proven.

## Next scoped candidate

The API emits `orca-mail-spacer-table` only for an unmarked, full-width, single-row table with one nonblank content cell and at least one blank structural gutter. Local headers, captions, column definitions, spans, multiple rows and explicit roles exclude the table. Blank detection permits only whitespace and simple structural wrappers; empty anchors, images, separators, code and semantic nested tables are not gutters. Sender-supplied classes are still stripped.

Native CSS applies automatic column sizing only to this trusted table hint. This next experiment also marks only the blank direct gutter cells of an already validated table and gives those cells a preferred `width:0!important`. It does not force zero maximum width or suppress intrinsic minimums. The native measurement block now records body content width, actual/computed gutter widths, nested gutter-table widths and table-layout modes, and requires body content to reach at least 80% of reader width. Tables are not flattened; no text, links, rows, cells, dimensions or styles are removed by the hint. Existing presentation-role classification, `hasLayout` and font behavior are unchanged. Headerless multi-cell statistics and captioned/header data tables retain fixed table layout. A single-row data table with one populated cell and blank cells is inherently indistinguishable from a spacer wrapper, so this is a sizing hint, not a claim that the table is presentational.

Outbound sanitization and remote-image blocking are unchanged. Independent review caught that the image-loading intermediate provider pass stripped roles before the classifier. A dedicated image-source pass now retains only inert table roles until the existing inbound classifier validates/removes them; it grants no resource or style capability and leaves outbound policy unchanged. Failed and successful synthetic loads test outer and nested semantic-role exclusions, plus presentation-role consistency. Image loading also tests marker/hash/revision consistency. Current v2 image revisions hash raw input and are unaffected. Legacy sanitized-body hashes change for newly marked content; an older cached body may require refresh under the existing hash check. No compatibility guard is weakened. Gmail stores original HTML. Both thread-detail GET and paged recovery GET sanitize stored content on read; the route regression includes historical stored HTML and confirms source bytes stay unchanged. Online `ThreadView.load` fetches detail and saves a new cache snapshot. An already-open body or offline pre-change cache does not gain the marker by rerendering alone: it requires a successful API refresh plus the updated native CSS. The API-only stage is inert in older clients that lack the new CSS; an updated iOS app against the old API retains baseline layout until the hint arrives. No provider resync, data migration or release is part of this PR.

## Acceptance and verification

The same WKWebView fixture and thresholds run at widths 272, 342 and 700, body sizes 22 and 44, in light and dark (12 layouts):

- Title content width at least 80% of reader width, excluding padding, and at most three title lines.
- Added: body content width also at least 80%, with actual gutter and nested-table widths recorded for diagnosis.
- Both short numeric statistics on one line.
- Added: headerless statistics remain a real table with two aligned columns on both rows; numeric values and labels stay associated.
- Captioned data table remains a table with original headers, text and ordered links; no remote image elements.
- All original no-overflow, no-shrinking, cell-containment and body-size assertions remain unchanged.

Baseline assertions are not weakened or marked expected-failure. New native execution must pass, and existing reader/image/fixture suites must be inspected on the published candidate head. No workflow, timeout or filter changes are included. Local API/privacy tests, typecheck, lint and build are recorded in the PR; native candidate results are pending.

Explicit sender title/statistic font sizes remain 22/36 px, so the body-size matrix does not prove those inline sizes scale with Dynamic Type. The test is a WKWebView body harness, not a physical-device or full SwiftUI screen reproduction. The baseline and first-candidate source/pixels received independent review; this new candidate source review and hosted validation remain gates. The retained nested spacer cells still have sender-supplied 400 px heights. Excess vertical whitespace is a separate visual limitation: no heights, padding or descendants are removed to make the width test pass.

Local Linux Chromium could not create its process-singleton socket, including one authorized escalation (`socket() failed: Operation not permitted`). The supported cloud browser rejected local `file:` navigation. Neither restriction was bypassed and no local visual candidate verification is claimed.

No live mailbox access, credential change, production migration, merge, manual deployment or release was performed. Existing automatic branch CI/preview may run after publication. The clone and synthetic scratch evidence are retained; no owned server/browser process remains running.
