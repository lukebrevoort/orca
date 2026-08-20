import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { redactedSchedulingReplyBriefFixture } from "./reply-brief.fixture.ts";
import {
  createDeterministicReplyBrief,
  m6ReplyBriefRuntimeDecision,
  replyBriefContextBundleSchema,
  replyBriefDisclosureCopy,
  replyBriefOutputSchema,
} from "./reply-brief.ts";

describe("M6 Reply Brief runtime and data boundary", () => {
  test("selects the external read-only MCP runtime without an Orca-held OpenAI credential", () => {
    assert.deepEqual(m6ReplyBriefRuntimeDecision, {
      selectedRuntime: "external_chatgpt_or_codex_mcp",
      productLocation: "outside_orca",
      invocation: "explicit_user_action",
      providerAccess: "read_only",
      chatGptCredentialOwner: "external_client",
      openAiApiCredential: "not_present",
      continuousMailboxIngestion: false,
      fallback: "orca_deterministic",
    });
  });

  test("processes the redacted scheduling fixture through the deterministic fallback", () => {
    const brief = createDeterministicReplyBrief(redactedSchedulingReplyBriefFixture);

    assert.match(brief.intent.summary, /meeting time/i);
    assert.equal(brief.constraints[0]?.text, "The request specifies a 30-minute duration.");
    assert.equal(brief.availabilityContext.status, "free_busy_only");
    assert.deepEqual(brief.availabilityContext.busy, [
      { start: "2026-08-25T20:30:00.000Z", end: "2026-08-25T21:00:00.000Z" },
    ]);
    assert.equal(brief.sourceRefs.some((source) => source.kind === "availability"), true);
    assert.equal("draftText" in brief, false);
    assert.equal("action" in brief, false);
  });

  test("rejects context that was not explicitly requested by the user", () => {
    assert.equal(replyBriefContextBundleSchema.safeParse({
      ...redactedSchedulingReplyBriefFixture,
      invocation: { kind: "background_sync", invokedAt: "2026-08-19T17:05:00.000Z" },
    }).success, false);
  });

  test("allows only credential-free, query-free HTTP(S) source links", () => {
    const validBrief = createDeterministicReplyBrief(redactedSchedulingReplyBriefFixture);
    const unsafeUrls = [
      "javascript:alert(document.domain)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
    ];

    for (const sourceUrl of unsafeUrls) {
      assert.equal(replyBriefContextBundleSchema.safeParse({
        ...redactedSchedulingReplyBriefFixture,
        sources: redactedSchedulingReplyBriefFixture.sources.map((source, index) =>
          index === 0 ? { ...source, sourceUrl } : source
        ),
      }).success, false, `context should reject ${sourceUrl}`);

      assert.equal(replyBriefOutputSchema.safeParse({
        ...validBrief,
        sourceRefs: validBrief.sourceRefs.map((source, index) =>
          index === 0 ? { ...source, sourceUrl } : source
        ),
      }).success, false, `output should reject ${sourceUrl}`);
    }

    for (const sourceUrl of ["https://orca.example/thread/1#message-2", "http://localhost:5173/thread/1"]) {
      assert.equal(replyBriefOutputSchema.safeParse({
        ...validBrief,
        sourceRefs: validBrief.sourceRefs.map((source, index) =>
          index === 0 ? { ...source, sourceUrl } : source
        ),
      }).success, true, `output should allow ${sourceUrl}`);
    }

    for (const sourceUrl of ["https://user@orca.example/thread/1", "https://orca.example/thread/1?token=secret"]) {
      assert.equal(replyBriefOutputSchema.safeParse({
        ...validBrief,
        sourceRefs: validBrief.sourceRefs.map((source, index) =>
          index === 0 ? { ...source, sourceUrl } : source
        ),
      }).success, false, `output should retain sensitive URL restrictions for ${sourceUrl}`);
    }
  });

  test("rejects a model response that includes draft copy", () => {
    const valid = createDeterministicReplyBrief(redactedSchedulingReplyBriefFixture);

    assert.equal(replyBriefOutputSchema.safeParse({
      ...valid,
      draftText: "Tuesday works for me.",
    }).success, false);
    assert.equal(replyBriefOutputSchema.safeParse({
      ...valid,
      replyBody: "Let's meet at 2:00.",
    }).success, false);
    assert.equal(replyBriefOutputSchema.safeParse({
      ...valid,
      suggestedCopy: "How about Wednesday?",
    }).success, false);
  });

  test("rejects a response that attempts to invoke a provider write action", () => {
    const valid = createDeterministicReplyBrief(redactedSchedulingReplyBriefFixture);

    assert.equal(replyBriefOutputSchema.safeParse({
      ...valid,
      action: { type: "send", messageId: "message_redacted_scheduling" },
    }).success, false);
    assert.equal(replyBriefOutputSchema.safeParse({
      ...valid,
      considerations: [{
        ...valid.considerations[0],
        composeAction: { type: "create_draft" },
      }],
    }).success, false);
  });

  test("ships disclosure copy for content egress, retention, and opt-out", () => {
    assert.match(replyBriefDisclosureCopy.external.contentLeavingOrca, /selected thread/i);
    assert.match(replyBriefDisclosureCopy.external.retention, /does not retain/i);
    assert.match(replyBriefDisclosureCopy.external.disable, /Disconnect/i);
  });
});
