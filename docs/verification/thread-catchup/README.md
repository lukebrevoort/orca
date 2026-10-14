# Long-thread catch-up (draft)

Scope: web reader, including mobile web. The sidebar, inbox layout, and quiet reader controls are preserved. No search changes (#235), API/schema changes, new persistent storage, native runtime changes, live-mail tests, deployment, or release.

Baseline: `9844aca646feabbc843980ecdba1bf5e5fe34b14` (current main inspected October 14, 2026). Runtime: `933155e140aff258e478040e6a532f24dc6dfeba`. The PR head additionally contains synthetic evidence and harness assertions; the runtime files are unchanged from that commit.

## Problem and existing behavior

Main already selected first unread (latest when fully read), hid earlier history behind a disclosure, supported per-card expansion, folded trailing quotes, and offered contextual jumps. It did not remember reader position or show an entry unread count. Collapsed cards still consumed generous spacing and preview/recipient rows.

The inbox also launched its whole-thread mark-read PATCH before the detail request necessarily completed. A cold entry could therefore lose the real unread boundary before rendering. A stale cached payload could similarly pin an obsolete boundary before refresh.

## Decisions

- Capture real per-message unread flags from current detail before starting the existing inbox-open read mutation. Fresh prefetched detail remains immediate; expired or mailbox-version-mismatched detail must refresh before establishing entry state. Failed/cancelled detail entry does not mark read. No changes to the server's whole-thread read semantics.
- “N unread at entry” is a historical message count, **not** a remaining-to-read counter. The contract has message unread flags, not a reliable distinction between human replies, originals, sent messages, and automated follow-ups. Counting “replies” by subtracting one would mislead. A separately labeled “N new unread” uses unread messages whose identities were absent at entry. Refreshes do not rewrite the entry count.
- First entry scrolls/focuses the first unread card once (latest for fully read multi-message threads). A single message keeps its heading. Existing saved sessions take precedence over first-unread positioning.
- Keep the existing earlier-history disclosure. Revealed collapsed cards are compact sender/date rows; Enter/Space uses native buttons, expanded state is announced, and full dates are accessible descriptions. Expanded content retains existing quote and attachment access. Attachments remain metadata-only, with the existing provider-download explanation.
- Remember expanded cards, history disclosure, message anchor and pixel offset. Restore after card layout settles; user gestures cancel pending positioning. Account/thread identities are separate keys. The store is owned by the mounted inbox, is replaced on account/demo/signout changes, and clears on teardown. Retain at most 30 threads and 1,000 expansion IDs per thread; no bodies or addresses are retained by this new store.
- Restored sessions use exact body geometry, like the reader's existing keyboard-content-focus path, to prevent intrinsic-height estimates shifting the restored position. This trades some deferred-layout benefit for restoration correctness.

## Verification

Only disposable synthetic fixtures were used. New regressions were observed failing before implementation (missing entry count and session store). Tests cover entry count across read refresh, incoming unread, restored expansion, retention bounds/account keys, delayed detail before read, cancelled entry, stale mailbox versions, expired same-version prefetch, existing failed-read isolation, and reader navigation/body behavior.

- Final runtime focused suite: **155 tests, 952 assertions, zero failures** across App interaction, reader cards/session/body/rendering/navigation.
- Development all-workspace run: **1,470 tests passed** (95 shared, 740 API, 635 web). Later added cases and final geometry changes are covered by the focused run and exact-head hosted CI recorded in the PR.
- All workspace typechecks passed during development; final production web build passed. Evidence exporter tests: **4 passed**.
- Independent reviewer inspected runtime `a17b14b…`, and the focused `933155e…` follow-up, found no remaining blocking issues, and independently ran **8 reader tests / 52 assertions**, all passing. Earlier stale-cache/TTL findings were fixed and regression-tested.
- Exact-runtime Chromium: **12 scenarios**, 1440×900 and 390×900, light/dark × 60-message mixed unread / fully read / single-message. Zero page errors or horizontal overflow. Every return preserved its message anchor and offset; the sampled 900px scroll position returned to 900px in all 12 cases. Incoming replies did not scroll or expand automatically. Mixed entry issued exactly one read PATCH; fully read/single entry, return, and incoming updates issued no extra read PATCH.
- Native is unchanged. Existing PR Fixture Checks supplies hosted unsigned native build/unit/compose coverage; the CI-script path also automatically triggers Native Reader Checks. No dedicated native reader workflow dispatch or offline Mac was requested.

[Complete screenshot gallery](gallery.md) · [head browser results](head-results.json) · [baseline browser results](baseline-results.json) · [paired measurements](benchmark.md)

## Limits

The browser matrix uses Linux Chromium, not Safari/WebKit or a physical device. CSS uses the existing safe-area offsets, but Chromium's non-notched viewport does not validate actual iOS safe areas, browser chrome resizing, a full VoiceOver session, Dynamic Type, or the onscreen keyboard. The count/jump controls were visually checked against the bottom navigation in both themes. Default, expanded, hover, and keyboard-focus row states are captured.

Reading sessions intentionally do not survive reload/logout. Retention can evict an old session and caps expansion IDs in exceptionally large threads. Inner message display choices/quote toggles are not persisted; normal anchor restoration assumes comparable message content. Remote images or content that changes later can still change geometry. Native iOS retains its existing behavior and has not gained this web session store.

Whole-thread mark-read remains whole-thread: this does not introduce per-message read tracking or protect a reply that reaches the server between fetching details and the existing PATCH. The entry count describes the fetched snapshot. Paired browser timings exclude provider latency and are not a production speedup claim.

## Reproduction

Use a clean synthetic checkout, Bun 1.3.14, Node 24, and Playwright Chromium. Build web with `bun run --cwd apps/web build`, then start `bun --no-env-file apps/api/scripts/compose-fixture.ts`. Pass its private loopback connection file to `node apps/web/scripts/catchup-fixture-e2e.mjs <connection.json> <output-dir> head`. Never publish the connection file or fixture credentials. `ORCA_CHROMIUM_EXECUTABLE` optionally selects a newly launched local Chromium binary; the harness never attaches to an existing profile.

`CATCHUP_BENCH=1` selects the 240-message interaction benchmark. Build baseline and head separately, serve each build against the same synthetic fixture, and run fresh contexts in alternating paired order. The raw paired JSON and methodology are retained beside this report. Existing hosted fixture CI runs the correctness matrix automatically; no redundant dispatch is needed.
