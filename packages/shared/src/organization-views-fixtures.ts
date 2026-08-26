import type { OrganizationView, OrganizationViewResultPage } from "./organization-views.ts";

const createdAt = "2026-08-25T16:00:00.000Z";

export const organizationViewsFixture: OrganizationView[] = [
  {
    id: "view_weekly_production", workspaceId: "workspace_demo", name: "Weekly production review",
    description: "Unresolved production failures across every Account and primary Lane.", color: "#b44c42", position: 0,
    definition: { revision: 1, workflowStateIds: ["workflow_unresolved"], thread: { subjectContains: "production failure" } },
    revision: 1, createdAt, updatedAt: createdAt,
  },
  {
    id: "view_urgent_humans", workspaceId: "workspace_demo", name: "Urgent humans",
    description: "High Human Signal evidence from active customer Accounts.", color: "#0b9b84", position: 1,
    definition: { revision: 1, accountIds: ["account_gmail", "account_outlook"], humanSignal: { minimumScore: 7, classifications: ["likely_human"] }, thread: { readState: "unread" } },
    revision: 1, createdAt, updatedAt: createdAt,
  },
  {
    id: "view_orca_context", workspaceId: "workspace_demo", name: "Orca launch context",
    description: "Every Thread linked to the Orca project Context.", color: "#6aa9f5", position: 2,
    definition: { revision: 1, contextFilters: [{ context: { contextTypeId: "context_type_project", contextId: "context_orca" }, relationshipTypeId: "relationship_concerns" }] },
    revision: 1, createdAt, updatedAt: createdAt,
  },
];

export const organizationWeeklyViewResultsFixture: OrganizationViewResultPage = {
  viewId: "view_weekly_production", viewRevision: 1, accountIds: ["account_gmail", "account_outlook"], limit: 25, nextCursor: "demo-continuation",
  items: [{
    accountId: "account_gmail", accountEmail: "work@gmail.example", provider: "gmail", threadId: "thread_failure",
    subject: "Unresolved production failure", latestReceivedAt: "2026-08-25T18:00:00.000Z", messageCount: 4,
    readState: "unread", primaryLaneId: "lane_everything_else", sender: { name: "Deploy monitor", email: "deploy@status.example.com" },
    humanSignal: 3, humanClassification: "automated_or_bulk",
  }],
};
