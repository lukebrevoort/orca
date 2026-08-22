import { replyBriefContextBundleSchema } from "./reply-brief.ts";

/** Synthetic, redacted scheduling request for boundary and fallback tests. */
export const redactedSchedulingReplyBriefFixture = replyBriefContextBundleSchema.parse({
  contractVersion: "m6-reply-brief-v1",
  invocation: {
    kind: "explicit_user_action",
    invokedAt: "2026-08-19T17:05:00.000Z",
  },
  thread: {
    id: "thread_redacted_scheduling",
    selectedMessageId: "message_redacted_scheduling",
    subject: "Time to review the proposal",
    messages: [
      {
        id: "message_redacted_scheduling",
        sender: { name: "Redacted collaborator", email: "collaborator@example.invalid" },
        subject: "Time to review the proposal",
        receivedAt: "2026-08-19T17:00:00.000Z",
        bodyExcerpt: "Could we meet Tuesday or Wednesday between 2:00 and 4:00 PM Mountain? I need 30 minutes to review the proposal.",
        sourceRef: "message:message_redacted_scheduling",
      },
    ],
    sourceRef: "thread:thread_redacted_scheduling",
  },
  sources: [
    {
      id: "thread:thread_redacted_scheduling",
      kind: "thread",
      label: "Time to review the proposal",
      sourceUrl: "http://localhost:5173/thread/thread_redacted_scheduling",
      observedAt: "2026-08-19T17:00:00.000Z",
    },
    {
      id: "message:message_redacted_scheduling",
      kind: "message",
      label: "Selected scheduling request",
      sourceUrl: "http://localhost:5173/thread/thread_redacted_scheduling/message/message_redacted_scheduling",
      observedAt: "2026-08-19T17:00:00.000Z",
    },
  ],
  availability: {
    kind: "free_busy_only",
    timeZone: "America/Denver",
    windowStart: "2026-08-25T20:00:00.000Z",
    windowEnd: "2026-08-26T22:00:00.000Z",
    busy: [
      { start: "2026-08-25T20:30:00.000Z", end: "2026-08-25T21:00:00.000Z" },
    ],
    observedAt: "2026-08-19T17:04:30.000Z",
  },
  safety: {
    contentTrust: "untrusted_external_content",
    bodyPolicy: "selected_thread_bounded_plain_text",
    redactionsApplied: true,
    truncatedFields: [],
  },
});
