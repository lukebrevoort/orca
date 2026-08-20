import type { AgentEventKind } from "@orca/shared";

import type { GmailMessage } from "../../providers/gmail/types.ts";
import type { GraphMessage } from "../../providers/outlook/types.ts";

export type DeterministicPropagationFixture = {
  name: string;
  provider: "gmail" | "outlook";
  expectedDestination: "timeline" | "none";
  expectedEventKind: AgentEventKind;
  message: GmailMessage | GraphMessage;
};

export const deterministicPropagationFixtures: DeterministicPropagationFixture[] = [
  {
    name: "gmail testflight release",
    provider: "gmail",
    expectedDestination: "timeline",
    expectedEventKind: "release_available",
    message: gmailMessage({
      id: "gmail-testflight-1",
      threadId: "gmail-testflight-thread",
      from: "TestFlight <no_reply@email.apple.com>",
      subject: "Orca 2.1 (42) is ready to test",
      snippet: "A new beta build is available to test.",
      headers: [{ name: "Auto-Submitted", value: "auto-generated" }],
    }),
  },
  {
    name: "gmail routine newsletter",
    provider: "gmail",
    expectedDestination: "none",
    expectedEventKind: "marketing_or_newsletter",
    message: gmailMessage({
      id: "gmail-newsletter-1",
      threadId: "gmail-newsletter-thread",
      from: "Acme News <newsletter@acme.example>",
      subject: "Your weekly product newsletter",
      snippet: "New stories and special offers. Unsubscribe any time.",
      labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
      headers: [
        { name: "List-ID", value: "Acme weekly <weekly.acme.example>" },
        { name: "List-Unsubscribe", value: "<mailto:unsubscribe@acme.example>" },
      ],
    }),
  },
  {
    name: "gmail account security alert",
    provider: "gmail",
    expectedDestination: "timeline",
    expectedEventKind: "security_or_account_alert",
    message: gmailMessage({
      id: "gmail-security-1",
      threadId: "gmail-security-thread",
      from: "Google Accounts <no-reply@accounts.google.com>",
      subject: "Security alert: new sign-in on macOS",
      snippet: "A new sign-in was detected for your account.",
      headers: [{ name: "Auto-Submitted", value: "auto-generated" }],
    }),
  },
  {
    name: "outlook deploy failure",
    provider: "outlook",
    expectedDestination: "timeline",
    expectedEventKind: "ci_or_deploy_failure",
    message: outlookMessage({
      id: "outlook-ci-1",
      conversationId: "outlook-ci-thread",
      fromName: "GitHub Actions",
      fromAddress: "notifications@github.com",
      subject: "Workflow failed: deploy production",
      preview: "The deploy production workflow failed.",
      categories: ["Automated"],
    }),
  },
  {
    name: "outlook payment receipt",
    provider: "outlook",
    expectedDestination: "timeline",
    expectedEventKind: "receipt_or_renewal",
    message: outlookMessage({
      id: "outlook-receipt-1",
      conversationId: "outlook-receipt-thread",
      fromName: "Stripe",
      fromAddress: "receipts@stripe.com",
      subject: "Payment receipt for Orca Cloud",
      preview: "Your payment was successful.",
      categories: ["Receipt"],
    }),
  },
  {
    name: "outlook travel change",
    provider: "outlook",
    expectedDestination: "timeline",
    expectedEventKind: "travel_or_booking_change",
    message: outlookMessage({
      id: "outlook-travel-1",
      conversationId: "outlook-travel-thread",
      fromName: "United Airlines",
      fromAddress: "notifications@united.com",
      subject: "Your flight itinerary changed",
      preview: "Flight 42 has been delayed.",
      categories: ["Travel", "Notification"],
    }),
  },
];

function gmailMessage(input: {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  labelIds?: string[];
  headers?: Array<{ name: string; value: string }>;
}): GmailMessage {
  return {
    id: input.id,
    threadId: input.threadId,
    labelIds: input.labelIds ?? ["INBOX", "CATEGORY_UPDATES"],
    snippet: input.snippet,
    internalDate: "1787155200000",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: input.from },
        { name: "To", value: "Luke <luke@example.com>" },
        { name: "Subject", value: input.subject },
        ...(input.headers ?? []),
      ],
      body: { data: Buffer.from(input.snippet).toString("base64url") },
    },
  };
}

function outlookMessage(input: {
  id: string;
  conversationId: string;
  fromName: string;
  fromAddress: string;
  subject: string;
  preview: string;
  categories: string[];
}): GraphMessage {
  return {
    id: input.id,
    conversationId: input.conversationId,
    subject: input.subject,
    bodyPreview: input.preview,
    receivedDateTime: "2026-08-19T16:00:00.000Z",
    isRead: false,
    from: { emailAddress: { name: input.fromName, address: input.fromAddress } },
    toRecipients: [{ emailAddress: { name: "Luke", address: "luke@example.com" } }],
    body: { contentType: "text", content: input.preview },
    categories: input.categories,
    internetMessageHeaders: [{ name: "Auto-Submitted", value: "auto-generated" }],
  };
}
