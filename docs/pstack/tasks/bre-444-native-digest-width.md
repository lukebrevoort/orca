# BRE-444: native digest width diagnostic

- Intent / playbook: regression-first investigation of narrow character stacks in the iOS reader. This patch adds tests and a synthetic fixture only. No renderer or sanitizer behavior changes.
- Status: **running**. Next action: independent test review, draft PR, then inspect the automatically triggered hosted WKWebView baseline and screenshots.
- Base: `faf41b80a1ec3149ee34d9782235c889023d59ea`; branch `codex/bre-444-native-width-diagnostic`.
- Ownership: diagnostic owner and independent source/test reviewer. Held PRs #295/#298 and PR #292–#295 descriptions/media remain untouched.
- Source: [BRE-444](https://linear.app/brevoort/issue/BRE-444/feedback-look-at-this-compilation-the-text-isnt-readable). Its screenshot was visually inspected and shows narrow title fragments and numeric statistics, not low contrast. The exact original email HTML and installed iOS source revision are unknown.

## Source-supported hypothesis

`SafeHTMLView.swift` forces every table to `table-layout:fixed` and every cell to `width:auto`, including unmarked sender layouts. `sanitizeInboundHtml` intentionally recognizes only safe explicit presentation-role tables. Empty cells in nested unknown tables therefore receive equal fixed-layout shares instead of yielding width to content. An outer two-column wrapper followed by a three-column header can reduce its content cell to roughly one sixth of the reader width. This is a hypothesis until the hosted runtime supplies measurements, not a claim that the reported message has been reproduced.

The synthetic fixture follows the unmarked spacer/header/statistics topology in public Discourse source at `444e62cc26e96c7da97f08fa45df219f03f60114`:

- [Digest wrapper](https://github.com/discourse/discourse/blob/444e62cc26e96c7da97f08fa45df219f03f60114/app/views/user_notifications/digest.html.erb)
- [Header](https://github.com/discourse/discourse/blob/444e62cc26e96c7da97f08fa45df219f03f60114/app/views/user_notifications/digest/_header.html.erb)
- [Statistics](https://github.com/discourse/discourse/blob/444e62cc26e96c7da97f08fa45df219f03f60114/app/views/user_notifications/digest/_stats.html.erb)

It is not a full Discourse rendering or a copy of private mail. All content and URLs are synthetic. The API test compares the Swift literal byte-for-byte with the production sanitizer output, and confirms images stay blocked and data headers/caption remain intact.

## Acceptance and expected result

The new WKWebView test runs the unchanged production reader shell at widths 272, 342 and 700, body sizes 22 and 44, in light and dark appearances (12 layouts). It captures each screenshot and emits synthetic metrics before its assertions. It requires:

- Title cell content width at least 80% of reader width, excluding padding, and at most three rendered title lines.
- Both short numeric statistics on one line.
- Original text and ordered link destinations retained, no remote image elements, and the captioned data table still displayed as a table with its headers.
- Existing no-overflow, no-shrinking, cell-containment and requested body-size requirements remain unchanged.

**The new native readable-width test is expected to fail on the unchanged renderer.** A red baseline is useful only after inspecting the precise assertion, measurements and screenshots. Compilation, launch or unrelated failures do not confirm the hypothesis. This draft must not be merged as-is. Do not weaken the test to make CI green.

Explicit sender title/statistic font sizes remain 22/36 px. The body-size matrix does not prove those inline sizes scale with Dynamic Type. The test is a WKWebView body harness, not physical-device or full SwiftUI screen evidence.

## Verification and limits

Local focused sanitizer tests pass (11 tests, 48 assertions). Typecheck/lint/build results are recorded with the draft PR. Swift compilation and WKWebView execution require hosted macOS/Xcode. The existing Native Reader workflow is triggered by this Swift test path; no workflow, timeout, test filter or assertion was removed or relaxed. General Fixture Checks also includes native unit tests.

The Linux Chromium doctor could not create its process-singleton socket, including one authorized escalation (`socket() failed: Operation not permitted`). The supported cloud browser rejected local `file:` navigation. Neither restriction was bypassed. No local visual reproduction, screenshot comparison or candidate-fix verification is claimed.

Independent review of the diagnosis supports the mechanism as a strong hypothesis and cautions against treating global automatic table layout as a proven safe fix. A later fix must be based on the native baseline, preserve semantic/headerless data tables and privacy, and rerun the complete relevant native suite. No API policy broadening, original-image request, live mailbox access, credential change, production migration, merge, deployment or release was performed.

The clone/dependencies and synthetic scratch evidence are retained. No owned server or browser process remains running.
