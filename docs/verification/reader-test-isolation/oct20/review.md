# Independent October 20 integration review

Reviewed merge commit `98933664b47598bc85667af54d94336844ef1a03` against pinned main `6fa05f9cd6891a58a986fc922ebc4d94b3ac5efe`. No repository source changes, merge actions, publication, or CI dispatch performed.

## Result

No blocking findings. Only executable delta is the silent-refresh test repair in `apps/web/src/App.interaction.test.tsx`. Also removed one obsolete comment that described PR252's silent-refresh work as separate. Remaining changed files are historical verification documents.

Programmatically compared immutable git blobs: main's scheduler helper, settling/history helpers, and all three Retry cases remain byte-identical. Content before the silent-refresh test and after the helpers/Retry cases is identical. Production runtime (including App.tsx and thread-detail-cache.ts), dependencies/bun.lock, and AGENTS.md remain unchanged. The repaired silent-refresh test itself is byte-identical to previously reviewed executable `4ff6db53215a4e1b629e39ad86042784773c1f45`.

## Independent validation

Ran: `PATH=/workspace/.orca-tools/node_modules/.bin:$PATH bun test apps/web/src/App.interaction.test.tsx --test-name-pattern 'retries a failed silent|fetches fresh detail after'`

On reviewed merge HEAD, Bun 1.3.14: **4 pass, 0 fail, 131 filtered out, 86 assertions**, 3.25 seconds. Silent refresh and held/completed/in-flight Retry cases all passed.

Read archived pinned-main result `/tmp/orca252-oct20/main-focused.log`: 3 Retry cases pass; silent-refresh fails at exact detail count (expected 2, received 3), 58 assertions. This is supplied baseline evidence, not an independent rerun by this reviewer.

## Unique coverage and assertion quality

The remaining test repair distinguishes guidance, destination, and primary mailbox query contracts; asserts observing all three; settles initial mailbox/provider loading before selecting the reader and arming failure; and serves a consistent changed mailbox across request contracts. It requires exact primary mailbox counts 2/3/4 and selected detail counts 1/2/3, account-qualified detail requests, consumption of the injected failure, persistent reader node/title without loading during failure, and successful unchanged-version retry on the next focus refresh. Finally it runs queued real prefetch and asserts no extra selected-detail request for the recovered hot cache. Timer state is restored in finally.

No assertion weakening found. The prior primary-mailbox lower bound is replaced with exact phase counts; the updated title is enforced by readerSettles' asserted predicate. The focused baseline failure and retained phase assertions demonstrate useful remaining coverage beyond merged PR261's Retry cases. No duplicate Retry implementation or runtime rollback was introduced.

## Limits

Historical October 16 evidence must remain labeled historical; it is not final October 20 full-suite/CI evidence. Parent is collecting current integration validation. This review covers pinned commits, independent focused validation and source parity; it does not claim full-suite, hosted CI, UI or mobile-anchor verification. The earlier unresolved mobile-anchor observation remains unrelated and unclaimed as fixed.
