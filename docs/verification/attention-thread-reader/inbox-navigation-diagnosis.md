# Native inbox single-tap diagnosis — 2026-10-09

The compose check for reader PR #237 failed at its first inbox navigation on source `f8af05016bcf7ab0bbc9581e828789c20ac3f9a8` (tested merge `041a51fdab1deda46e08d5ea594e02527263ca65`). Of 144 tests, 128 unit tests and 15 UI tests passed; the initial conversation did not open after one tap. Reply/draft/send assertions in that test were never reached.

[Original hosted run](https://github.com/lukebrevoort/orca/actions/runs/37969719483) · [retained synthetic evidence](https://github.com/lukebrevoort/orca/actions/runs/37969719483/artifacts/11638070931)

## Observations

- The failure screenshot and accessibility hierarchy show the first row fully visible at `(0, 460, 402, 150.33)`, with Inbox still active and no modal. Both first and second rows are realized.
- The synthesized tap took 1.153 seconds. The unchanged 10-second navigation wait expired. Initial automation setup took about 85 seconds; this is a correlation, not a proven cause.
- A fresh owned iPhone 17 Pro simulator (402 × 874 points, iOS 26.4.1, Xcode 26.4.1) ran the full single UI test against an isolated loopback fixture. It passed in 54 seconds. Both initial and post-search opens used one tap; the draft reopened and one synthetic delivery completed.
- Reinstalling the app and running all 128 unit tests before the same UI flow also passed (128 unit + 1 UI). The initial row had the same frame as CI and was enabled and hittable. Its tap took 1.441 seconds, followed by a 1.101-second successful navigation wait. The post-search open also passed with one tap.

## Change and limits

No production cause was reproduced and no speculative production change was made. The test now asserts that its initial, already-visible row is enabled and hittable. The navigation helper records accessibility element type, frame, enabled state, and hittability immediately before the existing single tap. Existing failure screenshot/hierarchy and navigation timing remain available. No tap retries, sleeps, or timeout increases were added.

Independent review found this diagnostic strengthening appropriate and no established production navigation defect. Another successful hosted run would establish that the failure did not recur; it would not prove a root cause or justify calling the original failure fixed or flaky. Final hosted results belong in the PR description so they can reference the tested commit without a self-referential source update.

All mail, drafts, and sends in this investigation are synthetic. Existing light/dark native reader screenshots remain representative because this follow-up changes tests only.
