import { describe, expect, test } from "bun:test";

import { detectGmailCapabilities } from "./capabilities.ts";

describe("Gmail capabilities", () => {
  test("treats a legacy null scope as the original read-only grant", () => {
    expect(detectGmailCapabilities(null)).toEqual({ read: true, draft: false, send: false });
    expect(detectGmailCapabilities("")).toEqual({ read: false, draft: false, send: false });
  });

  test("keeps a read-only connection unable to draft or send", () => {
    expect(detectGmailCapabilities("https://www.googleapis.com/auth/gmail.readonly")).toEqual({
      read: true,
      draft: false,
      send: false,
    });
  });

  test("maps the minimum compose grant to draft and send capabilities", () => {
    expect(detectGmailCapabilities([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
    ])).toEqual({ read: true, draft: true, send: true });
  });

  test("recognizes send-only and broader legacy grants without requesting them", () => {
    expect(detectGmailCapabilities("https://www.googleapis.com/auth/gmail.send")).toEqual({ read: false, draft: false, send: true });
    expect(detectGmailCapabilities("https://www.googleapis.com/auth/gmail.modify")).toEqual({ read: true, draft: true, send: true });
  });
});
