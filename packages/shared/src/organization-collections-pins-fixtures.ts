import {
  organizationCollectionPinQueryResponseSchema,
  type OrganizationCollectionPinQueryResponse,
} from "./organization-collections-pins.ts";

/** Provider-neutral M8 replacement data for clean-reset demos and adapter tests. */
export const organizationCollectionPinDemoFixture: OrganizationCollectionPinQueryResponse =
  organizationCollectionPinQueryResponseSchema.parse({
    workspaceId: "workspace_demo",
    accountIds: ["account_personal", "account_work"],
    collections: [{
      id: "collection_launch",
      accountId: "account_personal",
      name: "Orca launch",
      color: "#70867d",
      position: 0,
      threadIds: ["thread_launch", "thread_research"],
      revision: 1,
      createdAt: "2026-08-23T12:00:00.000Z",
      updatedAt: "2026-08-23T12:00:00.000Z",
    }],
    pins: [{
      id: "pin_deployments",
      accountId: "account_work",
      label: "Failed deployments",
      icon: "bolt",
      color: "#83728d",
      position: 0,
      target: { type: "query", queryId: "query_failed_deployments" },
      revision: 1,
      createdAt: "2026-08-23T12:00:00.000Z",
      updatedAt: "2026-08-23T12:00:00.000Z",
    }],
    queries: [{
      id: "query_failed_deployments",
      accountId: "account_work",
      name: "Failed deployments",
      definition: { revision: 1, filters: { text: "deployment failed" } },
      revision: 1,
    }],
  });
