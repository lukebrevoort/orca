# Reply from the owning account

## Sub-features

Open the second-account conversation and reply while the workspace profile remains the first account.

## How to get to it (user POV)

Select the message row containing second account conversation, then Reply.

## Driving it with Playwright

The harness uses `button.message-row` filtered by `second account conversation`, `getByRole("button", {name:"Reply", exact:true})`, and `.compose-workspace-reply`. It enters text, captures `light-second-account-reply.png` / `dark-second-account-reply.png`, then clicks Send reply twice. The fixture ledger must add one delivery with account `second`, thread `second-thread`, subject `Re: second account conversation` and recipient `maya@example.com`.

## Gotchas

Requires both synthetic accounts and the seeded second thread. Do not substitute a first-account reply if fixtures change. This covers the compose reply path, not long-thread reader catch-up.
