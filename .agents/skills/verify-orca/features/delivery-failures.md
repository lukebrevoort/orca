# Handle invalid, uncertain and unauthorized delivery

## Sub-features

Reject invalid recipients without dispatch, preserve writing after uncertain provider outcome, suppress unsafe replay, and remove writing controls after session rejection.

## How to get to it (user POV)

In Compose enter an unfinished Cc address and Send; separately use the fixture-induced uncertain delivery and rejected-session paths.

## Driving it with Playwright

The harness asserts no POST /send or delivery for invalid recipient input, captures `*-invalid-recipient-retained.png`, verifies text/attachments remain for uncertain delivery, and checks that replay does not invoke the provider again. It captures `*-uncertain-delivery-retained.png` and `*-session-rejected.png` with scenario assertions in the browser results. Run the entire owned trial to establish the required isolated fixture states.

## Gotchas

Expected product failure scenarios can pass their assertions. A deliberately failed lifecycle trial still exits nonzero and must be validated with `evidence --expect-failure`; it is never a successful product run. Session rejection must not use a live login.
