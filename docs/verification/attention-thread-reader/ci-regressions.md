# Hosted regression follow-up

RED evidence: [Fixture Checks run 37869947345](https://github.com/lukebrevoort/orca/actions/runs/37869947345), PR head `4ba2c3b69fd4d7c33d8364a9d9e460936f444372` (tested merge `c98735e5`). Original artifacts downloaded intact to `/tmp/orca-237-red-37869947345` before edits.

- Browser artifact 11589951871: all four 60-message interaction profiles timed out at line 106 on `.reader-formatted-region.first()`, a hidden earlier card. All four single-message variants passed. The 34-case matrix had not run.
- iOS artifact 11590387159: 141 passed, two failed. `test35RichDraftConversionAtAccessibilitySize` and `test36SentRecoveryStatusAtAccessibilitySize` failed the second inbox row existence assertion before Drafts opened. The native List realizes rows within its viewport; added headings increase the space before the second row at Accessibility XXXL.

The profile now targets the latest open card, asserts exactly one card is initially expanded, and explicitly expands all cards before exercising the unchanged whole-thread Find/focus/dynamic-layout checks. History waits target the initially open latest body. The Newest locator follows the current accessible label. The full matrix now explicitly requires the notification's unique footer and quote to remain visible with exact text preservation, consistent with the conservative quote-folding rule.

The iOS helper performs up to five scrolls to realize the second row, retains its existence assertion, restores the initial scroll position, and verifies the first row again. No product code, fixture content, priority semantics, or accessibility coverage is removed.

Local checks: JavaScript syntax, diff whitespace, four reader-card/quote regression tests (25 assertions). Hosted browser and native results must be checked against the final pushed head; local checks do not establish native viewport or Chromium Find behavior.
