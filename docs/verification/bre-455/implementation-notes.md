# BRE-455 backend candidate — running, not verified

The draft preserves the version-1 shared settings/claim wire. Original baseline red remains historical evidence at `29e345e3c8943acc68e884d68dacd302c8a5c3a4`; source/API checks from parent BRE-454/BRE-461 do not verify this candidate. Root owns independent correctness/security reviews and integrated runtime/client gates.

## Arrival evidence and limits

Gmail persistence records new-message evidence once, in its final authorized transaction after message/label projection, using the same batched `readImportance` resolver as public reads. Existing messages without evidence are not backfilled. Unknown evidence is retained with a reason and never promoted by routine resync. Current eligibility is checked again at dispatch. Important choices made after arrival cannot replay that arrival even before the scheduler's first scan.

`gmail_smtp_metadata` means provider-observed metadata consistent with ordinary SMTP delivery to this connected account's exact primary address. The parser consumes the original ordered/duplicated headers, requires consistent primary `Delivered-To`, and uses the first external `Received` hop with exact `by mx.google.com`, ESMTP transport and exact `for <primary>` recipient. A later sender-inserted trace cannot override an earlier contradictory hop. It requires a valid provider internalDate and receiving time within two minutes of one another, neither more than one minute future nor five minutes old at ingestion. SENT, DRAFT and own-primary senders are excluded. Unknown aliases, missing trace, contradictions, old or invalid dates remain quiet. Current Inbox, destination, saved view, Human Signal and latest sender do not establish eligibility. Evidenced archived/moved arrivals remain eligible.

This is **not cryptographic SMTP evidence**, a complete alias catalog, or reliable import detection. Gmail API imports can reproduce indistinguishable headers and internalDate, so a forged import coherent with these checks cannot be distinguished by this capability. Google's [label guide](https://developers.google.com/workspace/gmail/api/guides/labels) and [message resource](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages) describe labels and internalDate, not authenticated delivery provenance. Real-mail/physical-device ACCEPT-01 and universal incoming-direction claims remain unverified.

## Delivery semantics

Explicit settings command adopts the policy; status reads do not write. Intent, client-reported permission, current owner/session, APNs registration and server configuration are separate. Server permission is a report, never OS proof. Unadopted APNs keeps its previous placement preferences. Adoption cancels queued legacy work; old registration clients cannot replace Important-only intent with placement choices. Previous selections remain available for rollback.

First observation and each account's sequence/time boundary prevent old adoption/re-enable/new-account backlog. Identical settings preserve cursors and pending generations. Persistent account/conversation/installation cooldown reservations suppress arrivals within 900 seconds permanently; no delayed batch is promised. Browser claims are bounded, expire after 30 seconds and return stable IDs on a lost-response retry while still eligible. Clients must dedupe IDs before calling Notification and recheck actual permission/owner/request generation immediately before construction. Reports record constructor success/failure, never OS display. No service worker/closed-browser delivery is implemented. APNs uses ordinary alert priority and the existing encrypted token, lease and bounded retry transport with a stable APNs ID. A dispatch already handed to the OS has an unavoidable revocation race.

## Rollback

Keep the new policy disabled during review. Revert the candidate code as a unit while retaining the additive tables/receipts; do not edit stable migrations 0052/0053 or delete legacy selections/evidence. A live rollback needs an explicit migration plan because reverting to a legacy-only dispatcher could resume old placement delivery; do not run that dispatcher for adopted installations. No merge, deployment, credentials, scopes, live Gmail/APNs, signed build or TestFlight action is authorized here.

## Historical checkpoint receipts

- `101c45221f7ce1e452b5b9c4da3c86af69eb00f8` clean: unchanged legacy dispatcher red actually attempted/delivered one Unreviewed human message for an adopted Important-only installation; expected zero. Separate actual settings/browser/provenance checkpoint passed 10 tests, 77 expectations. It deliberately did not wire APNs policy dispatch.
- `6b51113049178ece0b8b8894679b173fb3d9e691` clean: focused notifications/mobile-push execution passed 54 tests and failed one (nonempty account deletion during token decryption raises a foreign-key error). The same historical adopted-Unreviewed transport test now passed with zero provider calls. API typecheck failed five narrow type errors; this is not a full passing candidate. Raw logs are retained separately. Source fixes and account-deletion diagnosis are in progress.

## Final migration ordering correction

Historical checkpoints through `c11cafe9` used policy `0054` and the new disposal fix `0055`. Those are unpublished synthetic-only checkpoints. Before final verification, the independent BRE-464 fix was renumbered to `0054_account_disposal_revisions` at timestamp `1791907200000`; notification policy became `0055_important_notification_policy` at `1791993600000`, preserving their SQL bytes. Parent PR311 must install only disposal 0054 before feature 0055. Drizzle compares the last applied timestamp, so publishing the reverse order would skip the later feature migration. The final suite includes an actual parent0054 → feature0055 → repeated no-op upgrade. Historical log filenames/SHAs remain historical and are not relabeled.
