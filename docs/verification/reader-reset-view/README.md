# Reader message view label

Base: `0e6805131a9c8386107bf70f598e2b61b0cf6a0b`.

Reproduced with three synthetic messages, first unread in the middle: open Conversation actions, Expand all, then Collapse all. Three open cards become one, retaining the initial unread message. Existing code also hides earlier cards. This is the intended entry-view reset; the old label incorrectly promises every card will close.

Changed only the label to **Reset message view**. Expansion, ordering, earlier-message visibility and navigation remain unchanged. The label wraps naturally in the existing compact menu.

Before changing production code, updated reader-card expectations failed twice because the accurately named action did not exist (`before-tests.log`). Afterward, 65 focused App/reader-card tests passed with 347 assertions. Added explicit checks for retaining the entry message, closing the menu, and returning focus to its summary. Production web TypeScript/build passed (`build.log`).

Browser: Chromium, synthetic loopback fixture only, external requests blocked; 390×900 mobile web and 1440×900 desktop web, light/dark, reduced motion. Both before/after matrices confirm three expanded cards become one, the initial unread message stays expanded, Enter activates the action, focus returns to the menu summary, and repeated activation is stable. See JSON files and screenshots in `before` and `after`. Inspected all four before/after menu images for readable labels, containment and wrapping. `menu-focus` filenames indicate DOM focus at capture, not a comprehensive focus-ring audit. Hover and result captures are supplementary evidence.

| View | Before | After |
| --- | --- | --- |
| Mobile light | [before](before/390-light-menu-focus.png) | [after](after/390-light-menu-focus.png) |
| Mobile dark | [before](before/390-dark-menu-focus.png) | [after](after/390-dark-menu-focus.png) |
| Desktop light | [before](before/1440-light-menu-focus.png) | [after](after/1440-light-menu-focus.png) |
| Desktop dark | [before](before/1440-dark-menu-focus.png) | [after](after/1440-dark-menu-focus.png) |

These are web screenshots, not native iOS pixels. No simulator, Safari, screen-reader, live mailbox, native or provider-network testing performed. No native files changed or CI manually dispatched. No navigation/order redesign, remote-image prototype, or PR #235 files changed.
