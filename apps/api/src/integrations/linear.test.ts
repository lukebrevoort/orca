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
      if (String(input) === "https://storage.googleapis.com/linear-production/feedback.png") {
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
                uploadUrl: "https://storage.googleapis.com/linear-production/feedback.png",
                assetUrl: "https://uploads.linear.app/feedback.png",
                headers: [{ key: "x-goog-meta-test", value: "test-token" }],
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
      assert.equal((uploadRequest?.headers as Headers).get("x-goog-meta-test"), "test-token");
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

describe("durable feedback delivery", () => {
  test("reconciles an existing issue by the durable ID without creating or uploading", async () => {
    const original = globalThis.fetch; const seen: unknown[] = [];
    const receipt = { identifier: "BRE-22", url: "https://linear.app/brevoort/issue/BRE-22" };
    globalThis.fetch = (async (_url, init) => { seen.push(JSON.parse(String(init?.body))); assert.ok(init?.signal); return Response.json({ data: { issue: receipt } }); }) as typeof fetch;
    try {
      const send = createLinearFeedbackSubmitter({ LINEAR_API_KEY: "test-only" })!;
      assert.deepEqual(await send({ ...report, attachments: [] }, { issueId: "10000000-0000-4000-8000-000000000001" }), receipt);
      assert.equal(seen.length, 1);
      assert.equal((seen[0] as { variables: { id: string } }).variables.id, "10000000-0000-4000-8000-000000000001");
    } finally { globalThis.fetch = original; }
  });
  test("lost create response is recovered on retry and every create uses the same UUID", async () => {
    const original = globalThis.fetch; const inputs: Array<{ id: string }> = []; let stored = false;
    const receipt = { identifier: "BRE-23", url: "https://linear.app/brevoort/issue/BRE-23" };
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.query.includes("query FeedbackIssue")) return Response.json({ data: { issue: stored ? receipt : null } });
      inputs.push(body.variables.input); stored = true; throw new Error("response lost after server accepted");
    }) as typeof fetch;
    try {
      const send = createLinearFeedbackSubmitter({ LINEAR_API_KEY: "test-only" })!;
      const options = { issueId: "10000000-0000-4000-8000-000000000002" };
      await assert.rejects(send({ ...report, attachments: [] }, options));
      assert.deepEqual(await send({ ...report, attachments: [] }, options), receipt);
      assert.equal(inputs.length, 1); assert.equal(inputs[0]!.id, options.issueId);
    } finally { globalThis.fetch = original; }
  });
  test("duplicate-create errors reconcile by exact ID", async () => {
    const original = globalThis.fetch; let lookups = 0;
    const receipt = { identifier: "BRE-24", url: "https://linear.app/brevoort/issue/BRE-24" };
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.query.includes("query FeedbackIssue")) return Response.json({ data: { issue: ++lookups === 1 ? null : receipt } });
      return Response.json({ errors: [{ message: "ID already exists" }] });
    }) as typeof fetch;
    try {
      const send = createLinearFeedbackSubmitter({ LINEAR_API_KEY: "test-only" })!;
      assert.deepEqual(await send({ ...report, attachments: [] }, { issueId: "10000000-0000-4000-8000-000000000003" }), receipt);
      assert.equal(lookups, 2);
    } finally { globalThis.fetch = original; }
  });
});

describe("private feedback media", () => {
  const issueId = "10000000-0000-4000-8000-000000000011";
  const receipt = { identifier: "BRE-31", url: "https://linear.app/brevoort/issue/BRE-31" };
  const upload = { uploadUrl: "https://storage.googleapis.com/linear-production/asset?signature=test", assetUrl: "https://uploads.linear.app/private/asset.png", headers: [{ key: "x-goog-meta-test", value: "fixture" }] };
  test("private uploads are reused after failed creation; every operation is bounded and key stays on GraphQL", async () => {
    const original = globalThis.fetch; let puts = 0, metadata = 0, creates = 0;
    const signals: AbortSignal[] = [];
    globalThis.fetch = (async (url, init) => {
      assert.ok(init?.signal); signals.push(init.signal); assert.equal(init.redirect, "error");
      if (init.method === "PUT") { puts++; const headers = new Headers(init.headers); assert.equal(headers.get("authorization"), null); assert.equal(headers.get("cache-control"), "private, no-store"); return new Response(null); }
      assert.equal(String(url), "https://api.linear.app/graphql");
      const body = JSON.parse(String(init?.body));
      if (body.query.includes("query FeedbackIssue")) return Response.json({ data: { issue: null } });
      if (body.query.includes("fileUpload")) { metadata++; assert.match(body.query, /makePublic: false/); return Response.json({ data: { fileUpload: { success: true, uploadFile: upload } } }); }
      creates++; assert.ok(body.variables.input.description.includes(upload.assetUrl));
      if (creates === 1) return Response.json({ errors: [{ message: "rejected" }] });
      return Response.json({ data: { issueCreate: { success: true, issue: receipt } } });
    }) as typeof fetch;
    try {
      const send = createLinearFeedbackSubmitter({ LINEAR_API_KEY: "test-only" })!;
      await assert.rejects(send(report, { issueId }));
      assert.deepEqual(await send(report, { issueId }), receipt);
      assert.equal(puts, 1); assert.equal(metadata, 1); assert.equal(creates, 2);
      assert.equal(new Set(signals).size, signals.length);
    } finally { globalThis.fetch = original; }
  });
  test("failed attachment upload never creates a ticket", async () => {
    const original = globalThis.fetch; let creates = 0;
    globalThis.fetch = (async (_url, init) => {
      if (init?.method === "PUT") return new Response(null, { status: 500 });
      const body = JSON.parse(String(init?.body));
      if (body.query.includes("query FeedbackIssue")) return Response.json({ data: { issue: null } });
      if (body.query.includes("fileUpload")) return Response.json({ data: { fileUpload: { success: true, uploadFile: upload } } });
      creates++; return Response.json({});
    }) as typeof fetch;
    try { await assert.rejects(createLinearFeedbackSubmitter({ LINEAR_API_KEY: "test-only" })!(report, { issueId })); assert.equal(creates, 0); }
    finally { globalThis.fetch = original; }
  });
  test("unsafe upload/asset URLs, redirect destinations and credential headers are rejected before PUT", async () => {
    const original = globalThis.fetch;
    for (const bad of [
      { ...upload, uploadUrl: "http://storage.googleapis.com/linear-production/x" },
      { ...upload, uploadUrl: "https://evil.example/x" },
      { ...upload, uploadUrl: "https://storage.googleapis.com/other-bucket/x" },
      { ...upload, uploadUrl: "https://secret@uploads.linear.app/x" },
      { ...upload, assetUrl: "https://uploads.linear.app/x?public-signature=secret" },
      { ...upload, assetUrl: "https://evil.example/file" },
      { ...upload, headers: [{ key: "authorization", value: "secret" }] },
    ]) {
      let puts = 0;
      globalThis.fetch = (async (_url, init) => { if (init?.method === "PUT") { puts++; return new Response(null); } return Response.json({ data: { fileUpload: { success: true, uploadFile: bad } } }); }) as typeof fetch;
      try { await assert.rejects(createLinearFeedbackSubmitter({ LINEAR_API_KEY: "test-only" })!(report)); assert.equal(puts, 0); }
      finally { globalThis.fetch = original; }
    }
  });
  test("reconciliation failure prevents uploads rather than treating unknown existence as absent", async () => {
    const original = globalThis.fetch; let requests = 0;
    globalThis.fetch = (async () => { requests++; return Response.json({ errors: [{ extensions: { code: "INTERNAL_SERVER_ERROR" } }] }); }) as unknown as typeof fetch;
    try { await assert.rejects(createLinearFeedbackSubmitter({ LINEAR_API_KEY: "test-only" })!(report, { issueId })); assert.equal(requests, 1); }
    finally { globalThis.fetch = original; }
  });
});

test("media upload receipt cache expires and stays bounded without retaining signed URLs or deleting assets", async () => {
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let clock = originalNow(); Date.now = () => clock;
  let metadataCalls = 0, puts = 0;
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === "PUT") { puts++; return new Response(null); }
    const body = JSON.parse(String(init?.body));
    assert.ok(!body.query.includes("DangerouslyDelete"));
    if (body.query.includes("query FeedbackIssue")) return Response.json({ data: { issue: null } });
    if (body.query.includes("fileUpload")) { metadataCalls++; return Response.json({ data: { fileUpload: { success: true, uploadFile: { uploadUrl: "https://storage.googleapis.com/linear-production/test?signature=private", assetUrl: `https://uploads.linear.app/private/${metadataCalls}.png`, headers: [] } } } }); }
    return Response.json({ errors: [{ message: "retry fixture" }] });
  }) as typeof fetch;
  try {
    const send = createLinearFeedbackSubmitter({ LINEAR_API_KEY: "test-only" })!;
    const issueId = "10000000-0000-4000-8000-000000000101";
    await assert.rejects(send(report, { issueId }));
    await assert.rejects(send(report, { issueId })); assert.equal(metadataCalls, 1);
    clock += 30 * 60 * 1000 + 1;
    await assert.rejects(send(report, { issueId })); assert.equal(metadataCalls, 2);
    for (let index = 0; index < 100; index++) await assert.rejects(send(report, { issueId: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}` }));
    await assert.rejects(send(report, { issueId })); assert.equal(metadataCalls, 103); assert.equal(puts, 103);
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
});

test("partial media upload failure reuses completed files and never confirms an incomplete ticket", async () => {
  const original = globalThis.fetch;
  const fullReport = { ...report, attachments: [report.attachments[0]!, { ...report.attachments[0]!, id: "second-file", name: "second.png" }] };
  const uploadedNames: string[] = []; let failedSecond = false, creates = 0;
  globalThis.fetch = (async (url, init) => {
    if (init?.method === "PUT") {
      if (String(url).includes("second.png") && !failedSecond) { failedSecond = true; return new Response(null, { status: 503 }); }
      return new Response(null);
    }
    const body = JSON.parse(String(init?.body));
    if (body.query.includes("query FeedbackIssue")) return Response.json({ data: { issue: null } });
    if (body.query.includes("fileUpload")) { const name = body.variables.filename; uploadedNames.push(name); return Response.json({ data: { fileUpload: { success: true, uploadFile: { uploadUrl: `https://storage.googleapis.com/linear-production/${name}`, assetUrl: `https://uploads.linear.app/private/${name}`, headers: [] } } } }); }
    creates++; assert.ok(body.variables.input.description.includes("second.png"));
    return Response.json({ data: { issueCreate: { success: true, issue: { identifier: "BRE-32", url: "https://linear.app/brevoort/issue/BRE-32" } } } });
  }) as typeof fetch;
  try {
    const send = createLinearFeedbackSubmitter({ LINEAR_API_KEY: "test-only" })!;
    const options = { issueId: "10000000-0000-4000-8000-000000000032" };
    await assert.rejects(send(fullReport, options)); assert.equal(creates, 0);
    await send(fullReport, options); assert.equal(creates, 1);
    assert.deepEqual(uploadedNames, [fullReport.attachments[0]!.name, "second.png", "second.png"]);
  } finally { globalThis.fetch = original; }
});
