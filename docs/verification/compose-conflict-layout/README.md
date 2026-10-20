# Compose conflict toolbar overlap

Reproduced product readability defect; focused fix ready for draft review, automatic CI pending.

- Base: `43d96d21d1f103d2097c7db9e3f0864afab27c11`.
- Tested/reviewed executable: `97f460ccad2bb8179a0cef15f3c2350266b8a81a`.
- Synthetic production-build browser fixture, 1440×1000, both themes. Ordinary composer: zero overlap. Draft conflict with Cc/Bcc and an attachment: 24,600 square CSS pixels overlap; toolbar visibly crosses recovery text. Attachment actionability and actual conflict recovery still succeed. This is not a claim of blocked recovery or data loss.
- Root cause: the panel writing field has `flex: 1` and `min-height: 0`; a tall recovery notice shrinks it below its editor/attachments/toolbar content. Overflow paints into its sibling notice. Scoped `flex: 1 0 auto` preserves intrinsic content height; existing panel-body scrolling handles overflow. Reply and Zen layout rules are unchanged.
- `before/checks.log` ends in the failing geometry assertion; `before/geometry.json` and screenshots show both themes. `after/` passes the same geometry/action/recovery probe: zero overlap and unchanged ordinary toolbar geometry.
- `scroll/` extends the focused probe on the same executable: 1440×700, 20-line plain body, expanded comparison, hover/focus states, footer scroll/hit test and actual keep-local recovery. Both themes pass, no page errors. Original remote body and local recovered body are asserted separately. Identity files confirm exact commit and cleanup.
- The permanent regression is in the existing compose browser harness; it asserts the toolbar ends above the conflict notice before exercising recovery. Existing automatic Fixture Checks will run it. No assertions or coverage weakened.
- `harness-initial-failure/` preserves a harness setup timeout: a session-only attachment changes the saved-status label. Corrected the probe to await saved status before adding the attachment. This is not a product failure or a retry of failing product assertions.

## Reproduction
Use the saved cloud prerequisites (Bun 1.3.14, Node24, locked dependencies and `/usr/bin/chromium`). From any directory:

```sh
python3 /path/to/this/run.py /tmp/new-evidence-dir /path/to/orca-checkout
```

The runner archives the checkout's immutable HEAD, copies existing dependencies, builds, launches only an owned loopback synthetic API/SQLite fixture, drives `probe.mjs`, and cleans its archive/fixture/browser. Output directory must not exist. The retained final probe includes the additional shorter-viewport checks; the initial before/after runs only measured 1440×1000 and recovery. Runner publication changes only its probe lookup to a sibling path; product sources are always archived from the reported HEAD.

## Review and limits
Independent reviewer `/root/conflict_review` reviewed the exact executable against the base; no blocking code finding. Separate agent, model diversity not claimed. Review addendum records final scroll evidence.

Inspected light/dark before/after conflict, ordinary-compose and shorter-viewport screenshots. Focus/hover/default/expanded recovery states and disabled plain-text formatting controls remain visibly labeled. No pressed toggle was changed. No native UI, screen reader, mobile viewport, long rich-text body, live provider or production-mail verification. Parent's two native P2 observations remain known and unrelated. No full local suite repeated for this follow-up; archived production build passes. Earlier sweep 137 tests/2,492 assertions belongs to base, not candidate. No merge, release, deployment, production migration, workflow dispatch, credential change, performance/TestFlight work or edits to PR235/252/253.
