# Native video-fixture selector review

Reviewer: `/root/review_native_video_fixture_b795`, independent Codex gpt-6.1-sol reviewer using the repository interrogate rubric. Read-only source/evidence review; no tests, builds, browser, network, simulator, PR or CI actions. Only this external report was written.

Exact comparison: `edd31499f18d4d4df2b8ca2c28811d3c35c0f271` → `b795d3e57e30dc211dc816e18a2ffe452982b19f`. The complete diff changes only test38 in `apps/ios/OrcaUITests/OrcaUITests.swift`.

## Verdict

**Scoped source APPROVED WITH COMMENTS.** No blocking correctness or security finding. The unique-video predicate plus unchanged downstream exact payload hash retains fixture identity adequately for this fresh, owned synthetic simulator. This does not establish a hosted picker pass, unblock downstream compose assertions by itself, or authorize merging.

## Act on

- No blocking source correction requested. Hosted execution must still demonstrate the actual picker selection, two previews, explicit review, synthetic submission/retry, and unchanged exact-video SHA assertion. Candidate grammar is syntax evidence only.

## Consider

- Clarify the external triage wording “No ... coordinate/force click” to “No **new** coordinate or force-click changes.” The existing `tapFeedbackPickerAsset` at `OrcaUITests.swift:720` uses the media tile's validated center because the descriptive Photos AX image lacks a hit point. That helper is unchanged and checks finite positive geometry plus containment in the actual picker and app. The new patch does not add a coordinate workaround, but the current triage phrase can read as claiming no coordinates are used anywhere. This is a documentation clarification, not a code blocker.

## Noted / supported

- Actual retained `checks.log:2361` reports expected_day November12 and one ready matching photo. Lines2434–2435 report photo November12 12:03AM and video November11 11:51PM. The old predicate therefore excludes the observed video even though it is present. The timestamp-source algorithm remains uninstrumented; no file-birth causation is inferred.
- `OrcaUITests.swift:591–598` now requires the existing `PXGGridLayout-Info` identifier and a Video label, retains the original ten-second existence bound, and requires count exactly1 before using firstMatch. An absent or duplicate exposed video fails rather than choosing an arbitrary asset.
- `scripts/ci/fixture-check.sh:89` creates a new named simulator for this job; cleanup shuts down and deletes only that recorded simulator at lines33–34. `run-fixture-tests.sh:121` imports the generated photo and the committed synthetic.mp4. Production/provider/private media paths are unchanged.
- The downstream original checks remain intact: exactly two previews and explicit review before Send (`OrcaUITests.swift:611–627`), synthetic first-submission failure/retry behavior, MIME pair image/png plus video/mp4, and exact video digest at line647. I independently hashed the committed MP4: `0a901c954fd7f21eeab6c48c2ac77e74368df72f9d2a061e88a1a462b1b376d4`, matching that assertion. A different unique video cannot make the complete test pass.
- No timeout increase, production mutation, runner/media change, authentication/credential change, new external authority or weakened attachment hash/retry assertion is present.
- I independently read the fetched Git objects: actual tested/event `24e231a6253dc8f51db7e1d51f501c56f01e6374` and published head41a have identical whole trees `abec51f7274d9bc8802c765d5dfa3ff4053c13a0`. Their commit identities remain distinct.
- Retained evidence supports preliminary layout Light1/1, Dark1/1 and DirectCaptureLight16/16, then FeedbackLight0/1. Main compose/unit Light and Dark were not started after the prelude failure. I did not view screenshots in this review; ROOT's five-image inspection is recorded separately, not relabeled as my visual validation.

## Dismissed / limits

- Date-independent matching is not an acceptance bypass: uniqueness remains required and the later exact submitted payload digest remains decisive. It removes an invalid shared-day assumption rather than accepting any arbitrary recording as a passing fixture.
- No claim of current hosted XCTest/SwiftUI, whole-app/all33, production, native delivery, merge or release acceptance follows from this scoped source review.
