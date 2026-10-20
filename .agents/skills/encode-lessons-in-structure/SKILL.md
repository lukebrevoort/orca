---
name: encode-lessons-in-structure
description: Turn a recurring Orca verification or engineering failure into a narrow executable guard.
---

# Encode lessons in structure

Adapted from pstack `principle-encode-lessons-in-structure`; see the retained MIT notice in `docs/pstack/LICENSE`.

Identify a repeated, observed failure and its violated invariant. Prefer the narrowest structural remedy: a domain type or state machine, boundary check, idempotent lifecycle, lint, or meaningful regression assertion. Place it where future paths cannot bypass it. Reproduce the failure before the fix, then exercise the guard and valid path. Avoid adding both a structural fix and redundant warning prose.

For this integration, the important examples are rejecting reused evidence destinations, binding artifacts to a tested commit, detecting tampered artifacts, and cleaning up only trial-owned resources. Verify the actual CLI behavior before saying these rules are enforced. If the lesson needs judgment, document one concrete counterexample in the appropriate skill instead of inventing an unreliable automated gate.
