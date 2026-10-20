# Reused native CI diagnostics

Luke explicitly requested fixing the CI step and before/after evidence after PR259 native job118068122777 failed1 of16 light tests. The tail omitted the failed assertion, and retrieval of sanitized artifact12188816755 returned HTTP403. That denied route is not retried or bypassed.

Exact exporter and tests reused byte-for-byte from existing draft PR253 at9e3eaff354feeafc3e09e25d783e9e00e9fb2e69. PR253 itself is not modified. This avoids a competing diagnostic implementation. Source commits there: ba41941 and88b2c0a. Diagnostic executable here:743d8ffbec4e87ce39d9aeefcb6acd7c04ec23d9; prior PR259 head:e71c240e8b87904f1eb7db23057bc3393cb011c8.

Before: new eight exporter tests against prior exporter fail with one failure (early testEarly assertion omitted) and one missing-helper error. After: eight exporter tests and eight fixture-lifecycle tests pass. Tests cover early failure visibility, bounds, redaction, failure exit65 preservation, silence on success, fail-closed credential scanning and neutralized workflow-command delimiters. Test selection, assertions, timeouts, native/API code and workflow are unchanged.

This is a diagnostics fix, not a claim to fix the unidentified native test. A single push triggers existing automatic CI to identify the assertion if it reproduces. No manual dispatch or blind rerun. Full native root cause remains unknown until that evidence exists. Exact hosted before/after job results will be recorded in PR259 without documentation-only CI churn.

Requested before/after screenshot Library batch: supported upload helper failed while contacting the Library service before preparation/upload. No Library items were created; original committed before/after screenshots remain available. No direct-route substitution or retry attempted.

Independent review: /root/conflict_review reviewed e71c240e8b87904f1eb7db23057bc3393cb011c8→743d8ffbec4e87ce39d9aeefcb6acd7c04ec23d9, no blocking findings. Verified exact PR253 file equality, fail-closed redaction/scanning, bounded neutralized output and unchanged status/test selection. The first20-marker bound may still omit a later assertion; no claim otherwise. Separate agent, model diversity not claimed.
