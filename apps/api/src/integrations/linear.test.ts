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
  test("rejects an oversized description before any provider request", async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async () => { requests++; throw new Error("unexpected provider call"); }) as unknown as typeof fetch;
    try {
      const send = createLinearFeedbackSubmitter({ LINEAR_API_KEY: "test-only" })!;
      await assert.rejects(send({ ...report, description: "x".repeat(250_001) }));
      assert.equal(requests, 0);
    } finally { globalThis.fetch = originalFetch; }
  });
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
  test("reconciles existing or archived issues by exact durable ID without creating or uploading", async () => {
    const original = globalThis.fetch; const seen: unknown[] = [];
    const receipt = { identifier: "BRE-22", url: "https://linear.app/brevoort/issue/BRE-22" };
    globalThis.fetch = (async (_url, init) => { seen.push(JSON.parse(String(init?.body))); assert.ok(init?.signal); return Response.json({ data: { issues: { nodes: [receipt] } } }); }) as typeof fetch;
    try {
      const send = createLinearFeedbackSubmitter({ LINEAR_API_KEY: "test-only" })!;
      assert.deepEqual(await send({ ...report, attachments: [] }, { issueId: "10000000-0000-4000-8000-000000000001" }), receipt);
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0], {
        query: "query FeedbackIssue($id: ID!) { issues(filter: { id: { eq: $id } }, first: 1, includeArchived: true) { nodes { identifier url } } }",
        variables: { id: "10000000-0000-4000-8000-000000000001" },
      });
    } finally { globalThis.fetch = original; }
  });
  test("lost create response is recovered on retry and every create uses the same UUID", async () => {
    const original = globalThis.fetch; const inputs: Array<{ id: string }> = []; let stored = false;
    const receipt = { identifier: "BRE-23", url: "https://linear.app/brevoort/issue/BRE-23" };
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.query.includes("query FeedbackIssue")) return Response.json({ data: { issues: { nodes: stored ? [receipt] : [] } } });
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
      if (body.query.includes("query FeedbackIssue")) return Response.json({ data: { issues: { nodes: ++lookups === 1 ? [] : [receipt] } } });
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
      if (body.query.includes("query FeedbackIssue")) return Response.json({ data: { issues: { nodes: [] } } });
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
      if (body.query.includes("query FeedbackIssue")) return Response.json({ data: { issues: { nodes: [] } } });
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
    if (body.query.includes("query FeedbackIssue")) return Response.json({ data: { issues: { nodes: [] } } });
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
    if (body.query.includes("query FeedbackIssue")) return Response.json({ data: { issues: { nodes: [] } } });
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


test("filtered reconciliation rejects malformed nodes and upstream errors before uploads or creation", async () => {
  const original = globalThis.fetch;
  const invalid = [
    { body: {}, status: 200 }, { body: null, status: 200 },
    { body: { data: { issues: null } }, status: 200 },
    { body: { data: { issues: { nodes: null } } }, status: 200 },
    { body: { data: { issues: { nodes: {} } } }, status: 200 },
    { body: { data: { issues: { nodes: [null] } } }, status: 200 },
    { body: { data: { issues: { nodes: [{ identifier: "BRE-1" }] } } }, status: 200 },
    { body: { data: { issues: { nodes: [{ identifier: "BRE-1", url: "https://linear.app/a" }, { identifier: "BRE-2", url: "https://linear.app/b" }] } } }, status: 200 },
    { body: { data: { issues: { nodes: [] } }, errors: {} }, status: 200 },
    { body: { data: { issues: { nodes: [] } }, errors: [{ extensions: { type: "authentication error" } }] }, status: 401 },
    { body: { data: { issues: { nodes: [] } }, errors: [{ extensions: { type: "ratelimited" } }] }, status: 429 },
    { body: { data: { issues: { nodes: [] } }, errors: [{ extensions: { code: "ENTITY_NOT_FOUND" } }] }, status: 200 },
  ];
  for (const value of invalid) {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json(value.body, { status: value.status }); }) as unknown as typeof fetch;
    try {
      await assert.rejects(createLinearFeedbackSubmitter({ LINEAR_API_KEY: "test-only" })!(report, { issueId: "10000000-0000-4000-8000-000000000111" }));
      assert.equal(calls, 1);
    } finally { globalThis.fetch = original; }
  }
});

test("delivery diagnostics expose only stage, HTTP status and bounded reason", async () => {
  const { feedbackDeliveryDiagnostic } = await import("./linear.ts");
  const originalFetch = globalThis.fetch;
  const secret = "private-note-media-signed-url-api-key";
  try {
    for (const stage of ["reconcile", "upload_prepare", "upload_put", "create"] as const) {
      globalThis.fetch = (async (url, init) => {
        const body = String(init?.body);
        const current = String(url).startsWith("https://storage.googleapis.com/") ? "upload_put"
          : body.includes("query FeedbackIssue") ? "reconcile" : body.includes("UploadFeedbackFile") ? "upload_prepare" : "create";
        if (current === stage) return Response.json({ errors: [{ message: secret }] }, { status: 403 });
        if (current === "reconcile") return Response.json({ data: { issues: { nodes: [] } } });
        if (current === "upload_prepare") return Response.json({ data: { fileUpload: { success: true, uploadFile: {
          uploadUrl: "https://storage.googleapis.com/linear-production/file?secret=" + secret,
          assetUrl: "https://uploads.linear.app/file", headers: [],
        } } } });
        return new Response(null, { status: 200 });
      }) as typeof fetch;
      const send = createLinearFeedbackSubmitter({ LINEAR_API_KEY: secret })!;
      // Create without reconciliation so its failure is the final failing operation.
      await assert.rejects(send(report, stage === "create" ? undefined : { issueId: "10000000-0000-4000-8000-000000000111" }), error => {
        assert.deepEqual(feedbackDeliveryDiagnostic(error), { stage, status: 403, reason: stage === "upload_prepare" ? "upload_graphql" : "failed" });
        assert.ok(!JSON.stringify(feedbackDeliveryDiagnostic(error)).includes(secret));
        return true;
      });
    }
    globalThis.fetch = (async () => { throw new DOMException(secret, "TimeoutError"); }) as unknown as typeof fetch;
    await assert.rejects(createLinearFeedbackSubmitter({ LINEAR_API_KEY: secret })!(report), error => {
      assert.deepEqual(feedbackDeliveryDiagnostic(error), { stage: "upload_prepare", status: null, reason: "timeout" });
      return true;
    });
    assert.deepEqual(feedbackDeliveryDiagnostic(new Error(secret)), { stage: "unknown", status: null, reason: "failed" });
  } finally { globalThis.fetch = originalFetch; }
});

test("upload preparation validates the response contract without disclosing private metadata or uploading on failure", async () => {
  const { feedbackDeliveryDiagnostic } = await import("./linear.ts");
  const original = globalThis.fetch;
  const secret = "private-signed-url-or-feedback";
  const upload = { uploadUrl: "https://storage.googleapis.com/linear-production/file?signature=" + secret,
    assetUrl: "https://uploads.linear.app/private/file", headers: [{ key: "x-goog-meta-test", value: secret }] };
  const success = (file: unknown) => ({ data: { fileUpload: { success: true, uploadFile: file } } });
  const cases: [unknown, string][] = [
    [null, "upload_response"], [[], "upload_response"], [{}, "upload_response"],
    [{ errors: [{ message: secret }] }, "upload_graphql"],
    [{ ...success(upload), errors: [{ extensions: { code: secret } }] }, "upload_graphql"],
    [{ ...success(upload), errors: { message: secret } }, "upload_graphql"],
    [success(null), "upload_response"], [success({ ...upload, uploadUrl: 42 }), "upload_response"],
    [success({ ...upload, uploadUrl: "invalid:" + secret }), "upload_url_protocol"],
    [success({ ...upload, uploadUrl: "https://untrusted.example/" + secret }), "upload_url_host"],
    [success({ ...upload, assetUrl: upload.assetUrl + "?signature=" + secret }), "asset_url"],
    [success({ ...upload, headers: null }), "upload_headers"],
    [success({ ...upload, headers: [{ key: "authorization", value: secret }] }), "upload_headers"],
    [success({ ...upload, headers: [{ key: "x-goog-meta-test", value: "a\r\n" + secret }] }), "upload_headers"],
    [success({ ...upload, headers: [null] }), "upload_headers"],
  ];
  try {
    for (const [payload, reason] of cases) {
      let requests = 0;
      globalThis.fetch = (async () => { requests++; return Response.json(payload); }) as unknown as typeof fetch;
      await assert.rejects(createLinearFeedbackSubmitter({ LINEAR_API_KEY: secret })!(report), error => {
        assert.deepEqual(feedbackDeliveryDiagnostic(error), { stage: "upload_prepare", status: 200, reason });
        assert.ok(!JSON.stringify(feedbackDeliveryDiagnostic(error)).includes(secret));
        return true;
      });
      assert.equal(requests, 1, "No PUT or ticket create may follow rejected preparation");
    }
  } finally { globalThis.fetch = original; }
});

test("upload URL predicate diagnostics stay bounded and preserve rejection precedence", async () => {
  const { feedbackDeliveryDiagnostic } = await import("./linear.ts");
  const original = globalThis.fetch;
  const secret = "private-feedback-user-filename-header-signature";
  const asset = "https://uploads.linear.app/" + secret;
  const cases: [string, string, string?][] = [
    ["https://storage.googleapis.com/uploads.linear.app.evil/file", "upload_url_bucket"],
    ["https://storage.googleapis.com/uploadsXlinearXapp/file", "upload_url_bucket"],
    ["https://storage.googleapis.com/uploads.linear.app", "upload_url_bucket"],
    ["https://storage.googleapis.com/uploads.linear.app%2Ffile", "upload_url_bucket"],
    ["https://storage.googleapis.com/Uploads.linear.app/file", "upload_url_bucket"],
    ["https://storage.googleapis.com/uploads.linear.app/../other/file", "upload_url_bucket"],
    ["https://storage.googleapis.com/other/file", "upload_url_bucket"],
    ["https://storage.googleapis.com.evil.example/uploads.linear.app/file", "upload_url_host"],
    ["https://uploads.linear.app.storage.googleapis.com/file", "upload_url_host"],
    ["http://storage.googleapis.com/uploads.linear.app/file", "upload_url_protocol"],
    ["https://private@storage.googleapis.com/uploads.linear.app/file", "upload_url_userinfo"],
    ["https://:private@storage.googleapis.com/uploads.linear.app/file", "upload_url_userinfo"],
    ["https://storage.googleapis.com:8443/uploads.linear.app/file", "upload_url_port"],
    ["https://storage.googleapis.com/uploads.linear.app/file#private", "upload_url_fragment"],
    ["https://storage.googleapis.com/uploads.linear.app/file", "asset_url", "https://uploads.linear.app/file?signature=private"],
    ["https://storage.googleapis.com/uploads.linear.app/file", "asset_url", "https://storage.googleapis.com/uploads.linear.app/file"],
    ["https://[" + secret, "upload_url_parse"],
    ["http://uploads.linear.app/" + secret, "upload_url_protocol"],
    ["invalid:" + secret, "upload_url_protocol"],
    [`https://${secret}@uploads.linear.app/file`, "upload_url_userinfo"],
    [`https://:${secret}@uploads.linear.app/file`, "upload_url_userinfo"],
    [`https://uploads.linear.app:8443/${secret}`, "upload_url_port"],
    [`https://uploads.linear.app/file#${secret}`, "upload_url_fragment"],
    [`https://storage.googleapis.com/${secret}/file`, "upload_url_bucket"],
    ["https://storage.googleapis.com/linear-/file", "upload_url_bucket"],
    ["https://storage.googleapis.com/linear-production", "upload_url_bucket"],
    ["https://storage.googleapis.com/linear-Production/file", "upload_url_bucket"],
    [`https://${secret}.example/file`, "upload_url_host"],
    ["https://linear-production.storage.googleapis.com.evil.example/file", "upload_url_host"],
    ["https://uploads.linear.app.evil.example/file", "upload_url_host"],
    ["https://linear-.storage.googleapis.com/file", "upload_url_host"],
    // Preserve old parsing precedence: upload parse, asset parse, upload checks, asset checks.
    ["https://[", "upload_url_parse", "https://["],
    ["http://untrusted.example/file", "asset_url", "https://["],
    [`http://${secret}@untrusted.example:8443/file#fragment`, "upload_url_protocol"],
    [`https://${secret}@untrusted.example:8443/file#fragment`, "upload_url_userinfo"],
    ["https://untrusted.example:8443/file#fragment", "upload_url_port"],
    ["https://untrusted.example/file#fragment", "upload_url_fragment"],
    ["https://untrusted.example/file", "upload_url_host", "http://uploads.linear.app/file"],
    ["https://uploads.linear.app/file", "asset_url", asset + "?signature=" + secret],
    ["https://uploads.linear.app/file", "asset_url", "https://untrusted.example/file"],
  ];
  try {
    for (const [uploadUrl, reason, assetUrl = asset] of cases) {
      let requests = 0;
      globalThis.fetch = (async () => {
        requests++;
        return Response.json({ data: { fileUpload: { success: true, uploadFile: {
          uploadUrl, assetUrl, headers: [{ key: "x-goog-meta-test", value: secret }],
        } } } });
      }) as unknown as typeof fetch;
      const privateReport = { ...report, id: secret, description: secret,
        attachments: [{ ...report.attachments[0]!, name: secret }] };
      await assert.rejects(createLinearFeedbackSubmitter({ LINEAR_API_KEY: secret })!(privateReport), error => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Linear upload preparation failed");
        assert.deepEqual(feedbackDeliveryDiagnostic(error), { stage: "upload_prepare", status: 200, reason });
        const event = JSON.stringify({ event: "feedback_delivery_failed", ...feedbackDeliveryDiagnostic(error) });
        assert.ok(!event.includes(secret));
        assert.deepEqual(Object.keys(JSON.parse(event)), ["event", "stage", "status", "reason"]);
        return true;
      });
      assert.equal(requests, 1, "Rejected preparation must not PUT or create a ticket");
    }
  } finally { globalThis.fetch = original; }
});

test("accepted upload URL forms retain the exact PUT URL and redirect restriction", async () => {
  const original = globalThis.fetch;
  const urls = [
    "https://storage.googleapis.com/uploads.linear.app/private%20file?X-Goog-Signature=private%2Bvalue&X-Goog-Credential=test",

    "https://storage.googleapis.com/linear-production/file?signature=private",
    "https://linear-production.storage.googleapis.com/file?signature=private",
    "https://uploads.linear.app/file?signature=private",
    // URL parsing already normalizes default ports, host case, and empty fragments.
    "https://UPLOADS.LINEAR.APP:443/file?signature=private#",
    "https://storage.googleapis.com/linear-a-1/file",
  ];
  try {
    for (const uploadUrl of urls) {
      const calls: { url: string; init: RequestInit | undefined }[] = [];
      globalThis.fetch = (async (url, init) => {
        calls.push({ url: String(url), init });
        if (calls.length === 1) return Response.json({ data: { fileUpload: { success: true, uploadFile: {
          uploadUrl, assetUrl: "https://uploads.linear.app/private/file", headers: [],
        } } } });
        if (calls.length === 2) return new Response(null, { status: 200 });
        return Response.json({ data: { issueCreate: { success: true, issue: {
          identifier: "BRE-1", url: "https://linear.app/brevoort/issue/BRE-1", title: "Test",
        } } } });
      }) as typeof fetch;
      await createLinearFeedbackSubmitter({ LINEAR_API_KEY: "test-key" })!(report);
      assert.equal(calls.length, 3);
      assert.equal(calls[1]!.url, uploadUrl, "Do not rewrite signed URLs");
      assert.equal(calls[1]!.init?.method, "PUT");
      assert.ok(calls.every(call => call.init?.redirect === "error"));
    }
  } finally { globalThis.fetch = original; }
});

test("Content-Disposition is forwarded intact while unsafe headers fail privately before PUT", async () => {
  const { feedbackDeliveryDiagnostic } = await import("./linear.ts");
  const original = globalThis.fetch;
  const secret = "private-filename-feedback-signature";
  const disposition = `attachment; filename="${secret}.png"; filename*=UTF-8''${secret}%20image.png`;
  const cases: [string, unknown, boolean][] = [
    ["Content-Disposition", disposition, true],
    ["content-disposition", disposition, true],
    ["CoNtEnT-DiSpOsItIoN", disposition, true],
    ["Content-Disposition", disposition + "\r\nx-injected: secret", false],
    ["Content-Disposition", "\r\n" + disposition, false],
    ["Content-Disposition", disposition + "\n", false],
    ["Content-Disposition", disposition + "\r", false],
    ["Content-Disposition", disposition + "\0", false],
    ["Content-Disposition", 42, false],
    ["Content-Disposition-Evil", disposition, false],
    ["Content-Disposition ", disposition, false],
    ["Authorization", secret, false],
    ["Host", "evil.example", false],
    ["Cookie", secret, false],
  ];
  try {
    for (const [key, value, accepted] of cases) {
      const calls: { url: string; init: RequestInit | undefined }[] = [];
      const uploadUrl = `https://storage.googleapis.com/uploads.linear.app/${secret}?signature=${secret}%2Bsigned`;
      globalThis.fetch = (async (url, init) => {
        calls.push({ url: String(url), init });
        if (calls.length === 1) return Response.json({ data: { fileUpload: { success: true, uploadFile: {
          uploadUrl, assetUrl: "https://uploads.linear.app/private/file",
          headers: [{ key, value }, { key: "x-goog-content-length-range", value: "4,4" }],
        } } } });
        if (calls.length === 2) return new Response(null, { status: 200 });
        return Response.json({ data: { issueCreate: { success: true, issue: {
          identifier: "BRE-1", url: "https://linear.app/brevoort/issue/BRE-1", title: "Test",
        } } } });
      }) as typeof fetch;
      const send = createLinearFeedbackSubmitter({ LINEAR_API_KEY: secret })!;
      if (accepted) {
        await send(report);
        assert.equal(calls.length, 3);
        const put = calls[1]!;
        assert.equal(put.url, uploadUrl);
        assert.equal(put.init?.method, "PUT");
        assert.ok(calls.every(call => call.init?.redirect === "error"));
        const headers = new Headers(put.init?.headers);
        assert.equal(headers.get("content-disposition"), disposition);
        assert.equal(headers.get("x-goog-content-length-range"), "4,4");
        assert.equal(headers.get("cache-control"), "private, no-store");
        assert.equal(headers.get("authorization"), null);
      } else {
        await assert.rejects(send({ ...report, id: secret, description: secret }), error => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, "Linear upload preparation failed");
          assert.deepEqual(feedbackDeliveryDiagnostic(error), { stage: "upload_prepare", status: 200, reason: "upload_headers" });
          assert.ok(!JSON.stringify(feedbackDeliveryDiagnostic(error)).includes(secret));
          return true;
        });
        assert.equal(calls.length, 1, "Invalid headers must not PUT or create an issue");
      }
    }
  } finally { globalThis.fetch = original; }
});
