import { z } from "zod";
import { authSessionSchema, inboxMessageSchema, mailAccountSchema } from "./schemas.ts";

export const accountFixture = mailAccountSchema.parse({
  id: "acct_local_gmail",
  provider: "gmail",
  email: "luke@example.com",
  displayName: "Luke Brevoort",
  capabilities: { read: true, draft: false, send: false },
});

export const authSessionFixture = authSessionSchema.parse({
  isAuthenticated: true,
  user: {
    id: "user_local_luke",
    email: accountFixture.email,
    name: accountFixture.displayName,
  },
  expiresAt: null,
  onboardingCompletedAt: null,
});

export const inboxFixture = z.array(inboxMessageSchema).parse([
  {
    id: "msg_local_1",
    accountId: accountFixture.id,
    provider: "gmail",
    providerMessageId: "gmail_msg_local_1",
    threadId: "thread_local_1",
    from: {
      name: "Maya Chen",
      email: "maya@example.com",
    },
    subject: "First Orca preview",
    snippet: "A quiet shell for human messages is ready for real inbox data.",
    receivedAt: "2026-06-28T17:30:00.000Z",
    unread: true,
    labels: ["INBOX"],
    attentionBehavior: "normal",
    humanSignal: 9,
    humanClassification: {
      automatic: {
        classification: "likely_human",
        score: 9,
        reasonCodes: ["direct_recipient"],
        classifierVersion: "m5-v1",
      },
      effective: {
        classification: "likely_human",
        score: 9,
        reasonCodes: ["direct_recipient"],
        classifierVersion: "m5-v1",
        source: "automatic_heuristic",
        userOverride: null,
      },
      userOverride: null,
    },
  },
]);
