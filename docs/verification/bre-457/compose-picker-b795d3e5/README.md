# Hosted picker failure and scoped test correction

This is evidence retention only. Source head is `b795d3e57e30dc211dc816e18a2ffe452982b19f`. No runtime, API, runner, Apple build or XCTest was rerun by this retention step. Publication remains on hold pending ROOT's other natural41a outcome audit and explicit clearance.

## Actual hosted before-evidence

Run43122924544/job130867673812/attempt1 used event/tested commit `24e231a6253dc8f51db7e1d51f501c56f01e6374`, with PR head `41a0998b14428f62280027f504678b1c243e5a77`. ROOT independently fetched the event's main97+41a parents and proved both whole content trees equal `abec51f7274d9bc8802c765d5dfa3ff4053c13a0`. Execution and head SHAs remain distinct. ZIP SHA256 is `8c083d1930352645789b33960e41cafa295f72520af0c4728475101108714106`.

| Actual phase | Result |
| --- | --- |
| FeedbackLayoutlight, intended test18 | 1 pass / 0 fail |
| FeedbackLayoutdark, intended test18 | 1 pass / 0 fail |
| DirectCaptureLight | 16 pass / 0 fail |
| FeedbackLight test38 | 0 pass / 1 fail, line593 video query |
| Main compose / unit phases, light and dark | NOT STARTED after failed prelude |

The exact photo-day readiness check completed; the picker showed the photo on November12 at00:03 and the one-second video on November11 at23:51. The original same-day video predicate therefore excluded the present video and its original10s wait failed. The evidence establishes this mismatch, not why the asset acquired that timestamp. [Full triage](reports/bre313-41a-compose-triage.md), [inspection inventory](reports/bre313-41a-compose-inspection.json), [full decoded job](reports/bre313-41a-compose-job-130867673812.log), and all original textual artifact files are retained without excerpts replacing raw data.

ROOT actually inspected exactly five of18 exported PNGs: [2](historical-41a-compose/screenshots/FeedbackLight-2.png), [4](historical-41a-compose/screenshots/FeedbackLight-4.png), [11](historical-41a-compose/screenshots/FeedbackLight-11.png), [20](historical-41a-compose/screenshots/FeedbackLight-20.png), and [26](historical-41a-compose/screenshots/FeedbackLight-26.png). These copies preserve ROOT's inspection; this retention worker does not claim independent visual review or inspection of the other13. No unique screenshot-to-assertion ordinal mapping is inferred.

## ROOT's test-only candidate

The [exact patch](test38-only.patch) changes only test38's video predicate to the unique `PXGGridLayout-Info` element whose label begins `Video, `, independent of the photo/import day. The original10s wait, exactly-one guard, two previews, explicit review, retry and exact submitted video SHA remain. The MP4 remains SHA256 `0a901c954fd7f21eeab6c48c2ac77e74368df72f9d2a061e88a1a462b1b376d4`. No product, runner, fixture or media bytes change.

The existing bounded coordinate helper is unchanged. This introduces no new coordinate or force-click behavior; it does not claim that the existing helper never uses coordinates. [Fresh independent source review](reports/bre457-video-picker-review-b795.md) is APPROVED WITH COMMENTS for this narrow diff. It is not hosted execution or current picker acceptance.

ROOT's [grammar manifest](grammar-b795d3e5/manifest.json) records all44 Swift inputs, exit0, empty parse log and matching clean start/end b795 identity, elapsed0.462s (wrapper70967 terminal0). This proves grammar only, not SwiftUI/XCTest typechecking, event routing, media selection, provider effects or light/dark runtime success.

## Exact proof boundaries

The executed full Foundation/API gate remains `f0e38725b0b18f82bb9a71d397cfa235473cbc77`:423/423 and all seven stages green. Its28 Foundation source inputs and five harness inputs remain byte-identical here. Of its broader69 inputs, exactly two now differ: `OrcaTests.swift` (e76's two cleanup-defer moves) and `OrcaUITests.swift` (b795's test38 predicate). Current44-file grammar covers both test changes. No423 or runner repeat is claimed; corrected XCTest setup and picker behavior still require hosted proof.

[Source/input identities](verified-input-identity.json) and [all25 copied-file hashes](retained-files.json) bind original raw logs, summaries, inspection/review, five inspected PNGs and the complete grammar receipt. Source changes from e76 are separated from its already-retained evidence-doc additions. ROOT retains current other41a job outcomes, rendered From/P04/Discard acceptance, all33 requirements, screenshots and the formal merge gate.
