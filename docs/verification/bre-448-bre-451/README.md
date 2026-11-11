# BRE-448 / BRE-451 Settings evidence

Status: implementation complete; independent correctness/security review and final integration gate belong to the parent coordinator. Draft PR only.

Base: `9ec3ca31afecc28a4af2bf8b40c48a5f1fb9a311`. Product candidate: `e4d870854692366c9185c03cd1850fdfab9f41d8`. The evidence/harness commit adds no product changes. Final HEAD checks are recorded in `final-results.json` (retained outside this commit to avoid recursive SHA claims).

## Actual demo (about one minute)

1. Start the owned fixture-only web preview: `bun --cwd apps/web dev --port 5188 --strictPort`.
2. Open `http://localhost:5188/dev/settings`. Enter a synthetic Default signature; change Compose format, Reply behavior, and reminder notification choice.
3. Click Compose. Choose Stay, then repeat and press Escape. The signature and choices remain; no API write occurs.
4. Resize to 390px. Use Jump to section → Privacy & data → Writing. Each heading receives focus below the sticky controls; unsaved choices remain.
5. Click a provider settings link. Choose Leave without saving to navigate, or Stay to preserve edits. Saving account choices is a separate explicit action.

Reproduce the automated demo from repository root with Node 24 on PATH:

```bash
BASE=http://localhost:5188 SHA=$(git rev-parse HEAD) EVIDENCE=/tmp/orca-settings-demo node docs/verification/bre-448-bre-451/settings-e2e.mjs
BASE=http://localhost:5188 SHA=$(git rev-parse HEAD) EVIDENCE=/tmp/orca-settings-regression node docs/verification/bre-448-bre-451/auditor-regression.mjs
```

The harness launches a clean headless browser/context, never a user tab. The demo walks both themes, takes screenshots and asserts state after actual control actions. Its selected screenshots are in [demo.html](demo.html). Additional captures remain in `/tmp/orca-settings-full-v4`.

## Concrete outcomes

- Before: **0/6 protected edits**, Compose/reload/Back × Light/Black; zero API writes. Reproduced before editing on our owned port 5188. `baseline-regression.json` records this run. Independent original audit remains `/tmp/orca-ui-audit-settings-20261110`.
- After: **6/6 protected edits** in the same action/theme matrix; enhanced assertion requires the exact signature after cancellation (a dialog alone is insufficient).
- Demo: **2 theme journeys**, **8 theme/viewport combinations** (Light/Black × 320/390/1024/1440 × height 900); **32 section landings** (8 sections × 2 mobile widths × 2 themes), each checked for heading clearance, heading focus, and absence of a leave prompt. Zero API writes in demo mode.
- Mobile baseline: auditor measured ~4,017px page at 390px with the section index hidden below 860px. Candidate exposes all **8** choices through one native select; desktop keeps its index. No horizontal overflow at any tested width.
- Existing workspace suite: **2,195 passed, 0 failed**, **10,490 assertions** (shared 187/226; API 1,140/4,176; web 868/6,088). Includes the existing settings slow-save/newer-edit, failed-save/retry, expired-session and stale-read tests, plus the new focused settings guard test (10 assertions).
- Full lint, typecheck and production build passed; build reports the existing large bundle warning. Final revision rerun logs are `/tmp/orca-settings-final-{tests,typecheck,lint,build}.log`.

## Design and boundaries

The root cause was accountDirty living only in SettingsHome while frame callbacks assigned location directly. Settings now registers with the existing view navigation guard, adds its history tracking while mounted, and uses the shared TopLayer contract for a Stay/Leave decision. Frame callbacks enter requestViewNavigation. The shared hook has one opt-in for same-document section links; Organization defaults remain unchanged. Account preference save/version logic stays explicit; discard invalidates an outstanding save response. Device reader changes do not set accountDirty.

No provider/API behavior changes. No live mail, OAuth, credentials, delivery, deployment, merge or PR watch. This is responsive web evidence, not native iOS evidence. Browser unload prompts require user activation and remain subject to browser/platform restrictions; reload and full-document Back use the browser prompt rather than custom UI. Tab termination/OS process kills cannot be guaranteed. The local Vite API proxy is unavailable; demo reads use synthetic data and API save resilience is covered by existing mocked interaction tests.

## Visual inspection and cleanup

Inspected light/dark screenshots for readable labels, modal keyboard focus, picker focus, selected radio states, hover Leave action, and disabled Saved state. The initial modal and sticky-picker positioning errors were corrected before the accepted run. Additional 320/1024/1440 screenshots are retained in `/tmp/orca-settings-full-v4`; selected PNGs keep the commit small. Owned server process is stopped after final verification; evidence remains. Rollback is a revert of this PR; no data migration or account write is needed.
# Independent review follow-up

Source review found that confirming Leave before an asynchronous Outlook authorization request cleared dirty state even when that request failed and Settings stayed open. A new synthetic browser regression reproduced **12 failed assertions in six cases** (both themes × provider unavailable/server failure/offline) on `9a29e0c060507f327b8752906bace42322d17030`. Unsaved values remained visible while Save became disabled and subsequent Compose was unprotected. Authorization now preserves dirty state until a real redirect; the existing native unload guard protects that navigation. No live provider call is used in the test.

The same regression also checks focus after Stay and two animation frames. All six focus checks passed before the fix; the source-identified competing-restoration concern was not reproduced. Final revision results are recorded in the PR separately from the earlier verification below. Reproduce with `node apps/web/scripts/settings-review-e2e.mjs http://127.0.0.1:5198 /tmp/settings-review-new` against an owned Vite server.

