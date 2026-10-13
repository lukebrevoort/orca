# Empty Drafts guidance

Base: `0e6805131a9c8386107bf70f598e2b61b0cf6a0b`.

The empty Drafts screen told people to “Open Write”, although desktop labels the action Compose and the mobile web pencil has accessible name Compose. No Write button exists. This stale instruction is corrected to “Choose Compose”; the existing controls and navigation are unchanged.

## Reproduction and verification

Synthetic loopback fixture only (`apps/api/scripts/compose-fixture.ts`), Chromium, reduced motion, 390×900 mobile web and 1440×900 desktop, light and dark. Browser requests outside the fixture origin are blocked.

Before editing, the browser assertion that the instruction names Compose failed in all four states (`guidanceMatchesAction: false` in [before-results.json](before-results.json)). The visible Compose control opened the composer in every state. After the one-line change, the same assertion passed in all four states and Compose still opened the composer ([after-results.json](after-results.json)). All eight screenshots were visually inspected: no clipping or layout change beyond normal copy wrapping.

| Surface | Before | After |
| --- | --- | --- |
| Mobile web light | [Screenshot](before-390-light.png) | [Screenshot](after-390-light.png) |
| Mobile web dark | [Screenshot](before-390-dark.png) | [Screenshot](after-390-dark.png) |
| Desktop light | [Screenshot](before-1440-light.png) | [Screenshot](after-1440-light.png) |
| Desktop dark | [Screenshot](before-1440-dark.png) | [Screenshot](after-1440-dark.png) |

Validation: `bun run build` passed (all workspaces); `bun test apps/web/src/mobile-mail.test.tsx` passed (5 tests, 28 assertions).

Re-run after building and starting the fixture:

```sh
node docs/verification/drafts-compose-guidance/verify.mjs /path/from/fixture/connection.json after
```

`before` mode explicitly expects the mismatch and records the failing assertion without aborting the matrix. Set `CHROMIUM_PATH` if Chromium is installed elsewhere.

Limits: mobile web is not native iOS. No native simulator pixels, live-mail account, provider service, send operation, or accessibility audit is claimed. This is a copy correction, not a redesign or a new composer entry point.
