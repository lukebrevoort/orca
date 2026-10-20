Independent reviewer /root/workflow_review
Reviewed executable: 83eaf9f228d7a2599f04ee8adf2bfccc61d979e4

Original full-suite failure remains docs/verification/gmail-date/recovery/final-tests.log.
Independent isolated command (apps/web): bun test src/attention-page.test.tsx
Result: exit 0, 46 passed, 0 failed, 598 assertions, 37.38 seconds.
Log: /tmp/orca-date-attention-isolated-review.log

The failed assertion at attention-page.test.tsx:1259 follows click(Undo), whose helper only waits 20ms (226-270). attention-routing.tsx changed() clears receipt/notice synchronously then awaits onRefresh and refreshDestinations. undo() publishes Last routing change undone only after that await. Missing routing-feedback is therefore consistent with a legitimate intermediate state at the fixed-delay assertion.

No changes from baseline 2d104ea to reviewed commit in apps/web, apps/api/src/organization or apps/api/src/index.ts. The fixture intercepts /v1/sync/status and /v1/sync/gmail, so this scenario does not run Gmail recovery. This supports a preexisting test synchronization vulnerability, not a recovery regression. The actual failing baseline execution has not been reproduced; do not claim that proof or a fully green original full-suite run.

Recommendation: preserve failure and isolated success separately; if authorized to harden the test, wait for the expected Undo completion condition with a bounded deadline instead of another fixed delay. No code edited or unrelated PR252 fixture touched.
