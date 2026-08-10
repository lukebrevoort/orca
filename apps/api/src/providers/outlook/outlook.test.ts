import { createHmac } from "node:crypto";

import { describe, expect, test } from "bun:test";
import { createOutlookClient, OutlookApiError } from "./client.ts";
import { outlookMessageFixture } from "./fixtures/message.fixture.ts";
import { normalizeOutlookMessage } from "./normalizer.ts";

const inboxNextLink = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=opaque";
const inboxMessagePath = "/v1.0/me/mailFolders/inbox/messages";

describe("Outlook provider", () => {
  test("lists Graph messages, follows opaque pagination, and gets a message", async () => {
    const urls: string[] = [];
    const headers: Array<HeadersInit | undefined> = [];
    const client = createOutlookClient(async (input, init) => {
      urls.push(String(input));
      headers.push(init?.headers);

      if (urls.length === 1) {
        return Response.json({
          value: [outlookMessageFixture],
          "@odata.nextLink": inboxNextLink,
        });
      }

      if (urls.length === 2) {
        return Response.json({ value: [] });
      }

      return Response.json(outlookMessageFixture);
    });

    const page = await client.listInboxMessagePage({ accessToken: "token", pageSize: 10 });
    expect(page.messages).toEqual([outlookMessageFixture]);
    expect(page.nextCursor).not.toContain("skiptoken");
    expect(new URL(urls[0]!).pathname).toBe(inboxMessagePath);
    expect(new URL(urls[0]!).searchParams.get("$top")).toBe("10");
    expect(new URL(urls[0]!).searchParams.get("$orderby")).toBe("receivedDateTime desc");

    const finalPage = await client.listInboxMessagePage({
      accessToken: "token",
      cursor: page.nextCursor,
    });
    expect(finalPage).toEqual({ messages: [], nextCursor: null });
    expect(urls[1]).toBe(inboxNextLink);

    await client.getMessage("token", "message-1");
    expect(new URL(urls[2]!).pathname).toBe("/v1.0/me/messages/message-1");
    expect(new URL(urls[2]!).searchParams.get("$select")).toContain("internetMessageHeaders");
    expect(new Headers(headers[0]).get("authorization")).toBe("Bearer token");
    expect(new Headers(headers[0]).get("prefer")).toBe('outlook.body-content-type="html"');
  });

  test.each([401, 403])(
    "maps %i authorization errors without leaking provider response bodies",
    async (status) => {
      const client = createOutlookClient(
        async () => new Response("secret upstream detail", { status }),
      );
      await expect(client.getMessage("token", "message-1")).rejects.toEqual(
        new OutlookApiError("Outlook authorization needs attention", status, "auth"),
      );
    },
  );

  test("does not replay a cursor with a different account token", async () => {
    let requestCount = 0;
    const client = createOutlookClient(async () => {
      requestCount += 1;
      return Response.json({ "@odata.nextLink": inboxNextLink });
    });

    const page = await client.listInboxMessagePage({ accessToken: "account-a-token" });
    await expect(client.listInboxMessagePage({
      accessToken: "account-b-token",
      cursor: page.nextCursor,
    })).rejects.toEqual(
      new OutlookApiError("Invalid Outlook pagination cursor", 400, "provider"),
    );
    expect(requestCount).toBe(1);
  });

  test.each([
    ["another user's inbox", "https://graph.microsoft.com/v1.0/users/other-user/mailFolders/inbox/messages?$skiptoken=opaque"],
    ["a non-inbox folder", "https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages?$skiptoken=opaque"],
    ["the mailbox message collection", "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=opaque"],
    ["a different Graph path", "https://graph.microsoft.com/beta/me/mailFolders/inbox/messages?$skiptoken=opaque"],
    ["a different origin", "https://evil.example/v1.0/me/mailFolders/inbox/messages?$skiptoken=opaque"],
  ])("rejects cursors outside the exact inbox route: %s", async (_description, url) => {
    const client = createOutlookClient(async () => {
      throw new Error("Graph must not receive an out-of-scope cursor");
    });

    await expect(client.listInboxMessagePage({
      accessToken: "token",
      cursor: signedCursor(url, "token"),
    })).rejects.toEqual(
      new OutlookApiError("Invalid Outlook pagination cursor", 400, "provider"),
    );
  });

  test.each([
    ["empty", ""],
    ["plain text", "not-a-cursor"],
    ["unsupported version", "v2.payload.signature"],
    ["missing signature", "v1.payload"],
    ["invalid base64url", "v1.!payload.signature"],
    ["extra segment", "v1.payload.signature.extra"],
  ])("rejects malformed cursors: %s", async (_description, cursor) => {
    const client = createOutlookClient(async () => {
      throw new Error("Graph must not receive a malformed cursor");
    });

    await expect(client.listInboxMessagePage({ accessToken: "token", cursor })).rejects.toEqual(
      new OutlookApiError("Invalid Outlook pagination cursor", 400, "provider"),
    );
  });

  test("normalizes a Graph message into the shared provider model", () => {
    expect(normalizeOutlookMessage(outlookMessageFixture, { accountId: "account-1" })).toEqual({
      id: "outlook:account-1:message-1",
      accountId: "account-1",
      provider: "outlook",
      providerMessageId: "message-1",
      threadId: "outlook:account-1:conversation-1",
      from: { name: "Ada", email: "ada@example.com" },
      to: [{ name: "Luke", email: "luke@example.com" }],
      cc: [{ name: "Grace", email: "grace@example.com" }],
      bcc: [],
      subject: "A calm Outlook hello",
      snippet: "Hello from Microsoft Graph",
      receivedAt: "2026-08-09T18:00:00.000Z",
      unread: true,
      labels: ["Focused"],
      bodyText: null,
      bodyHtml: "<p>Hello from Microsoft Graph</p>",
      internetMessageId: "<message-1@example.com>",
      references: ["<earlier@example.com>"],
      raw: {
        provider: "outlook",
        accountId: "account-1",
        messageId: "message-1",
        threadId: "conversation-1",
        labelIds: ["Focused"],
      },
    });
  });

  test("normalizes missing optional fields deterministically", () => {
    expect(normalizeOutlookMessage({ id: "minimal" }, { accountId: "account-1" })).toMatchObject({
      id: "outlook:account-1:minimal",
      threadId: "outlook:account-1:minimal",
      subject: "(No subject)",
      snippet: "",
      receivedAt: "1970-01-01T00:00:00.000Z",
      unread: true,
      labels: [],
      bodyText: null,
      bodyHtml: null,
      references: [],
    });
  });
});

function signedCursor(url: string, accessToken: string): string {
  const payload = Buffer.from(url, "utf8").toString("base64url");
  const signedPayload = `v1.${payload}`;
  const signature = createHmac("sha256", accessToken)
    .update(signedPayload)
    .digest("base64url");
  return `${signedPayload}.${signature}`;
}
