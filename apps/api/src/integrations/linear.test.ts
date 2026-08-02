import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { FeedbackReport } from "@feedback-kit/core";

import { createLinearFeedbackSubmitter } from "./linear.ts";

const report: FeedbackReport = {
  schemaVersion: 1,
  id: "feedback-linear-test-1",
  project: { id: "orca", name: "Orca", environment: "development" },
  kind: "bug",
  severity: "high",
  title: "The feedback button is delayed",
  description: "The report should arrive in Linear with the captured context.",
  context: {
    url: "http://localhost:5173/dev/inbox",
    route: "/dev/inbox",
    title: "Orca",
    userAgent: "test-browser",
    viewport: { width: 1200, height: 800, pixelRatio: 1 },
    locale: "en-US",
    timezone: "America/Denver",
    capturedAt: "2026-08-02T00:00:00.000Z",
  },
  elements: [
    {
      selector: "#feedback",
      tagName: "button",
      text: "Feedback",
      bounds: { x: 0, y: 0, width: 100, height: 40 },
    },
  ],
  state: { token: "[REDACTED]" },
  metadata: { product: "orca", capture: "local-development" },
  attachments: [
    {
      id: "attachment-1",
      name: "screenshot.png",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,ZmFrZQ==",
      source: "automatic-screenshot",
    },
  ],
};

describe("Linear feedback integration", () => {
  test("does nothing when the API key is absent", () => {
    assert.equal(createLinearFeedbackSubmitter({}), undefined);
  });

  test("creates a correctly filed issue and returns its link", async () => {
    const originalFetch = globalThis.fetch;
    let request: RequestInit | undefined;
    let uploadRequest: RequestInit | undefined;
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init: Parameters<typeof fetch>[1],
    ) => {
      if (String(input) === "https://uploads.test/feedback.png") {
        uploadRequest = init;
        return new Response(null, { status: 200 });
      }

      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("fileUpload")) {
        return Response.json({
          data: {
            fileUpload: {
              success: true,
              uploadFile: {
                uploadUrl: "https://uploads.test/feedback.png",
                assetUrl: "https://uploads.linear.app/feedback.png",
                headers: [{ key: "x-upload-token", value: "test-token" }],
              },
            },
          },
        });
      }

      request = init;
      return Response.json({
        data: {
          issueCreate: {
            success: true,
            issue: {
              identifier: "BRE-201",
              title: "[Feedback] The feedback button is delayed",
              url: "https://linear.app/brevoort/issue/BRE-201/feedback-button-delayed",
            },
          },
        },
      });
    }) as unknown as typeof fetch;

    try {
      const submitter = createLinearFeedbackSubmitter({
        LINEAR_API_KEY: "linear-test-key",
        LINEAR_TEAM_ID: "team-id",
        LINEAR_PROJECT_ID: "project-id",
        LINEAR_FEEDBACK_LABEL_ID: "feedback-label-id",
        LINEAR_FEEDBACK_STATE_ID: "backlog-state-id",
        LINEAR_ASSIGNEE_ID: "assignee-id",
      });
      assert.ok(submitter);

      const result = await submitter(report);
      assert.deepEqual(result, {
        identifier: "BRE-201",
        url: "https://linear.app/brevoort/issue/BRE-201/feedback-button-delayed",
      });

      assert.equal(uploadRequest?.method, "PUT");
      assert.equal((uploadRequest?.headers as Headers).get("x-upload-token"), "test-token");
      const body = JSON.parse(String(request?.body)) as {
        variables: { input: Record<string, unknown> };
      };
      const input = body.variables.input;
      assert.equal((request?.headers as Record<string, string>).authorization, "linear-test-key");
      assert.equal(input.teamId, "team-id");
      assert.equal(input.projectId, "project-id");
      assert.equal(input.stateId, "backlog-state-id");
      assert.equal(input.assigneeId, "assignee-id");
      assert.deepEqual(input.labelIds, ["feedback-label-id"]);
      assert.equal(input.priority, 2);
      assert.match(String(input.description), /screenshot\.png/);
      assert.match(String(input.description), /https:\/\/uploads\.linear\.app\/feedback\.png/);
      assert.doesNotMatch(String(input.description), /data:image\/png;base64/);
      assert.match(String(input.description), /## Orca state/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("surfaces Linear validation details", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({
      errors: [{
        message: "Argument Validation Error",
        extensions: {
          userPresentableMessage: "description must be shorter than 100000 characters.",
        },
      }],
    })) as unknown as typeof fetch;

    try {
      const submitter = createLinearFeedbackSubmitter({ LINEAR_API_KEY: "linear-test-key" });
      assert.ok(submitter);
      await assert.rejects(
        () => submitter({ ...report, attachments: [] }),
        /description must be shorter than 100000 characters/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
