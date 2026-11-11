# Independent foundation design review

Reviewer: `/root/review_foundation_scope`, GPT-6.1-sol. Read-only source/design review on 2026-11-11; no runtime, security-execution, accessibility, usability or physical-device certification.

The reviewer successfully read all four current Space pages: Product Direction sequence 2, Purpose and Simplification sequence 2, Triage and Organization sequence 0, and Work Plan and Decisions sequence 1. Scope included the context, architecture, five journeys, all 16 surface specifications, decisions, components, visual system and 33 acceptance requirements.

Reviewed docs revision: `a5dcac04`; the sole blocking contradiction was corrected and re-reviewed at `7a2199768a1ec1b09ff118f44d3b287837270ebd`. Those documentation bytes were preserved through rebasing onto merged main in `4f7aff92f4e1f93b86a95c6fd5e86e3bf3045da7` (empty documentation diff verified). Later migration/acceptance clarifications below are coordinator follow-through on the review, rather than a claim that the reviewer executed product behavior.

- **Act on, resolved:** P01 restricted removal from Important to an acknowledged Not important action, contradicting reset-to-Unreviewed and sender-inheritance changes. Membership now follows the acknowledged effective result or current authorized refresh, retains inherited Important, rejects stale generations and restores focus only when displaced. Walkthroughs cover reset with and without inherited Important and changed sender/participant refresh.
- **Consider, specified before activation:** clarify existing legacy notification behavior, explicit adoption/account selection and freshness on adoption/re-enable/registration. D4 and BRE-455 now require a labeled previous-policy state until adoption, no backlog interruptions, generation fencing and synthetic ledger verification. Implementation remains pending.
- **Consider, specified before final acceptance:** enumerate real-use tasks and capture failures/reasons to return to Gmail. D7 and BRE-458 now identify the session, distinguish unavailable access/device evidence and forbid passing ACCEPT-01 from a handoff or synthetic fixture alone. Actual acceptance remains pending.

The reviewer found no further blocking design inconsistency after the P01 correction. This design result does not change any requirement's unverified implementation status.
