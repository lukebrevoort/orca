import type { GraphMessage } from "../types.ts";

export const outlookMessageFixture: GraphMessage = {
  id: "message-1",
  conversationId: "conversation-1",
  subject: "A calm Outlook hello",
  bodyPreview: "Hello from Microsoft Graph",
  receivedDateTime: "2026-08-09T18:00:00Z",
  isRead: false,
  from: {
    emailAddress: {
      name: "Ada",
      address: "ada@example.com",
    },
  },
  toRecipients: [{
    emailAddress: {
      name: "Luke",
      address: "luke@example.com",
    },
  }],
  ccRecipients: [{
    emailAddress: {
      name: "Grace",
      address: "grace@example.com",
    },
  }],
  body: {
    contentType: "html",
    content: "<p>Hello from Microsoft Graph</p>",
  },
  internetMessageId: "<message-1@example.com>",
  internetMessageHeaders: [{
    name: "References",
    value: "<earlier@example.com>",
  }],
  categories: ["Focused"],
};
