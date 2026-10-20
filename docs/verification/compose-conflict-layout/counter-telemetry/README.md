# Native counter timeout diagnostics

The exact-head native images job [118105515367](https://github.com/lukebrevoort/orca/actions/runs/39265974688/job/118105515367)
failed on `86bf5a5fe0a8b1aab1d6a6d09f756e3e4c7b14fb`: light passed,
dark timed out awaiting its initial fixture counter callback before Orca launch.
All other triggered jobs passed. No cause or product fix is claimed.

Luke authorized narrow privacy-safe telemetry and one automatic diagnostic run.
Implementation: `7c115660759bd88cc5b3d3f7cca47a9a417c5fa3`.
This extends the exporter originally reused from PR253; PR253 itself is unchanged.

- Native generated UUID correlates creation/resumption/callback with fixture receipt
  and response construction. Numeric HTTP/error/byte facts omit request URLs,
  credentials, payloads and error descriptions.
- A four-second background scheduler observation precedes the unchanged five-second
  expectation. No request retry, timeout increase or alternate success path.
- Image-only fixture heartbeat exposes event-loop liveness. Response construction
  does not prove socket delivery. The exporter prints bounded sanitized events on
  success and failure after its full credential scan; heartbeat selection is anchored
  to native observation time, avoiding loss during slow xcresult cleanup.
- `exporter-red.log`: new telemetry coverage fails against the prior exporter.
  `exporter-green.log`: 11 tests pass; `counter-green.log`: two tests/10 assertions;
  `lifecycle-green.log`: eight tests pass. All workspace typechecks passed.
- A real disposable loopback fixture check passed: authenticated count0,
  unauthenticated401, correlated receipt/response events, heartbeat, no credential
  or invalid trace-header content in emitted telemetry. Fixture process cleaned up.
- Independent reviewer `/root/conflict_review` reviewed the immutable implementation:
  no blockers; independently reran 11 exporter tests. Swift 5.9 compatibility was
  reviewed statically; hosted iOS compilation remains required. Separate agent,
  no model-diversity claim.

Interpretation: correlate UUID and epoch milliseconds to distinguish missing server
receipt, response construction without native completion, and scheduler/event-loop
gaps. These observations may localize a stalled layer without proving ultimate cause.
No artifact access retry or bypass; console evidence is intentionally sufficient
for this investigation. Existing assertions, authentication and coverage remain.
The next push starts the authorized diagnostic run; consult PR259 for its exact
published head and terminal results before treating any check as verified.
