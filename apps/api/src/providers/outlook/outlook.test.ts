import { describe, expect, test } from "bun:test";
import { createOutlookClient, OutlookApiError } from "./client.ts";
import { outlookMessageFixture } from "./fixtures/message.fixture.ts";
import { normalizeOutlookMessage } from "./normalizer.ts";

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
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=opaque",
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
    expect(new URL(urls[0]!).searchParams.get("$top")).toBe("10");
    expect(new URL(urls[0]!).searchParams.get("$orderby")).toBe("receivedDateTime desc");

    const finalPage = await client.listInboxMessagePage({
      accessToken: "token",
      cursor: page.nextCursor,
    });
    expect(finalPage).toEqual({ messages: [], nextCursor: null });
    expect(urls[1]).toBe(
      "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=opaque",
    );

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

  test("rejects pagination cursors that do not point back to a Graph message page", async () => {
    const client = createOutlookClient();
    const cursor = Buffer.from("https://example.com/steal-token").toString("base64url");

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
