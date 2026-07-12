import type { GmailMessage } from "../types.ts";

export const gmailMessageFixture: GmailMessage = {
  id: "msg_123",
  threadId: "thread_123",
  labelIds: ["INBOX", "UNREAD", "Label_42"],
  snippet: "A useful preview",
  internalDate: "1782671400000",
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "From", value: "Maya Chen <maya@example.com>" },
      { name: "To", value: "Luke Brevoort <luke@example.com>" },
      { name: "Subject", value: "Provider test" },
    ],
    parts: [
      {
        mimeType: "text/plain",
        body: { data: "SGVsbG8gZnJvbSBHbWFpbA==" },
      },
      {
        mimeType: "text/html",
        body: { data: "PHA-SGVsbG88L3A-" },
      },
    ],
  },
};
