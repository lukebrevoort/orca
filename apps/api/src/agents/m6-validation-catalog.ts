export type M6ValidationCase = {
  id: string;
  scenario: string;
  expected: string;
  automatedEvidence: string;
};

/**
 * The milestone closeout matrix is executable documentation: the companion
 * test proves that every acceptance scenario remains named and points to an
 * automated assertion. Live-only observations stay explicit in the HTML guide.
 */
export const m6ValidationCatalog = Object.freeze([
  {
    id: "release-availability",
    scenario: "TestFlight or release availability",
    expected: "Propagate to the base timeline while the source remains in Tideline.",
    automatedEvidence: "deterministic propagation fixture",
  },
  {
    id: "ci-deploy-failure",
    scenario: "CI or deploy failure",
    expected: "Propagate one high-importance failure with an understandable explanation.",
    automatedEvidence: "deterministic propagation fixture",
  },
  {
    id: "security-account-alert",
    scenario: "Security or account alert",
    expected: "Propagate the alert without treating email text as authorization or policy.",
    automatedEvidence: "deterministic propagation and prompt-injection tests",
  },
  {
    id: "receipt-renewal",
    scenario: "Receipt or renewal",
    expected: "Propagate a consequential charge or renewal under the conservative policy.",
    automatedEvidence: "deterministic propagation fixture",
  },
  {
    id: "travel-booking-change",
    scenario: "Travel or booking change",
    expected: "Propagate a meaningful itinerary change with a stable source link.",
    automatedEvidence: "deterministic propagation fixture",
  },
  {
    id: "routine-newsletter",
    scenario: "Routine newsletter or marketing",
    expected: "Suppress propagation by default and keep the original discoverable in Tideline.",
    automatedEvidence: "deterministic suppression fixture",
  },
  {
    id: "direct-human-correspondence",
    scenario: "Direct human correspondence",
    expected: "Do not create an automated event; retain Human Inbox semantics.",
    automatedEvidence: "human-authorship separation fixture",
  },
  {
    id: "uncertain-classification",
    scenario: "Uncertain classification",
    expected: "Do not force propagation; retain the Review classification.",
    automatedEvidence: "human-authorship separation fixture",
  },
  {
    id: "false-positive-and-mute",
    scenario: "False positive and user mute",
    expected: "Persist the local correction and suppress the configured future match without provider writes.",
    automatedEvidence: "lifecycle and policy persistence tests",
  },
  {
    id: "duplicate-and-follow-up",
    scenario: "Duplicate push and meaningful follow-up",
    expected: "Keep one event for a retry and update it for a meaningful follow-up.",
    automatedEvidence: "idempotency and follow-up tests",
  },
  {
    id: "mixed-thread",
    scenario: "Mixed human and automated thread",
    expected: "Keep propagation separate from per-message Human Signal and preserve thread attribution.",
    automatedEvidence: "mixed-thread contract test",
  },
  {
    id: "multiple-accounts",
    scenario: "Multiple connected accounts",
    expected: "Attribute events to the source account and reject cross-account reads or lifecycle changes.",
    automatedEvidence: "account-isolation propagation and MCP tests",
  },
] satisfies readonly M6ValidationCase[]);

