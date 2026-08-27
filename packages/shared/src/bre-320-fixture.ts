/**
 * Canonical provider-neutral production-failure journey shared by BRE-320
 * REST, MCP, evaluator, UI, and release-evidence gates.
 */
export const bre320ProductionFailureFixture = Object.freeze({
  workspace: { id: "bre320-workspace", email: "owner@orca.example", accountId: "bre320-account" },
  lanePolicy: {
    id: "bre320-policy-production", name: "Production response", visibility: "prominent" as const,
    interruption: "badge" as const, review: "continuous" as const,
    retention: { mode: "keep" as const, days: null },
  },
  lanes: {
    production: { id: "bre320-lane-production", name: "Production" },
    fallback: { id: "bre320-lane-everything", name: "Everything else" },
  },
  view: {
    id: "bre320-view-weekly-review", name: "Weekly review",
    description: "Production incidents that need the Friday systems review.", color: "#0b9b84",
  },
  collection: { id: "bre320-collection-release-health", name: "Release health", color: "#336699" },
  facet: { id: "bre320-facet-incident-kind", name: "Incident kind", value: "production_failure" },
  workflow: { id: "bre320-workflow-needs-review", name: "Needs review" },
  context: {
    typeId: "bre320-context-type-project", typeName: "Project",
    relationshipTypeId: "bre320-context-relationship-project", relationshipName: "belongs to",
    id: "bre320-context-orca", name: "Orca",
  },
  rule: {
    idempotencyKey: "bre320-rule-production-failures",
    name: "Production failures",
    reason: "A production failure stays operationally visible and joins the weekly review.",
    source: `orca 1
rule "Production failures"
event message.received
predicate from_release_system = sender.domain equals "deploy.example"
predicate failed = subject contains "failed"
when all(from_release_system, failed)
action route lane "Production"
action set workflow "Needs review"
action set facet "Incident kind" = "production_failure"
action add collection "Release health"
action link context "Project" "Orca"
because "A production failure stays operationally visible and joins the weekly review."`,
  },
  historicalThreads: [
    { id: "bre320-thread-production-checkout", messageId: "bre320-message-production-checkout", providerThreadId: "bre320-provider-thread-checkout", providerMessageId: "bre320-provider-message-checkout", subject: "Production checkout failed", receivedAt: "2026-08-24T15:10:00.000Z" },
    { id: "bre320-thread-production-webhook", messageId: "bre320-message-production-webhook", providerThreadId: "bre320-provider-thread-webhook", providerMessageId: "bre320-provider-message-webhook", subject: "Production webhook failed", receivedAt: "2026-08-25T09:20:00.000Z" },
    { id: "bre320-thread-routine-release", messageId: "bre320-message-routine-release", providerThreadId: "bre320-provider-thread-routine", providerMessageId: "bre320-provider-message-routine", subject: "Production release completed", receivedAt: "2026-08-25T11:45:00.000Z" },
  ],
  liveThread: { id: "bre320-thread-production-live", messageId: "bre320-message-production-live", providerThreadId: "bre320-provider-thread-live", providerMessageId: "bre320-provider-message-live", subject: "Production payments failed", receivedAt: "2026-08-26T18:05:00.000Z" },
  correction: { idempotencyKey: "bre320-correction-production-checkout", reason: "Human confirmed the incident still belongs in production review." },
});

export type Bre320ProductionFailureFixture = typeof bre320ProductionFailureFixture;
