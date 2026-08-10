import type { GraphMessage } from "./types.ts";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const graphBaseUrl = "https://graph.microsoft.com/v1.0";
const defaultPageSize = 25;
const messageFields = [
  "id",
  "conversationId",
  "subject",
  "bodyPreview",
  "receivedDateTime",
  "isRead",
  "from",
  "toRecipients",
  "ccRecipients",
  "bccRecipients",
  "body",
  "internetMessageId",
  "internetMessageHeaders",
  "categories",
].join(",");

export class OutlookApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: "auth" | "rate_limit" | "provider",
  ) {
    super(message);
    this.name = "OutlookApiError";
  }
}

export type OutlookMessagePage = {
  messages: GraphMessage[];
  nextCursor: string | null;
};

export type OutlookClient = {
  listInboxMessagePage(input: {
    accessToken: string;
    cursor?: string | null;
    pageSize?: number;
  }): Promise<OutlookMessagePage>;
  getMessage(accessToken: string, messageId: string): Promise<GraphMessage>;
};

export function createOutlookClient(fetchImpl: FetchLike = fetch): OutlookClient {
  return {
    async listInboxMessagePage({ accessToken, cursor, pageSize = defaultPageSize }) {
      const url = cursor
        ? decodeCursor(cursor)
        : new URL(`${graphBaseUrl}/me/mailFolders/inbox/messages`);

      if (!cursor) {
        url.searchParams.set("$top", String(pageSize));
        url.searchParams.set("$orderby", "receivedDateTime desc");
        url.searchParams.set("$select", messageFields);
      }

      const response = await request<{
        value?: GraphMessage[];
        "@odata.nextLink"?: string;
      }>(fetchImpl, accessToken, url);

      return {
        messages: response.value ?? [],
        nextCursor: response["@odata.nextLink"]
          ? encodeCursor(response["@odata.nextLink"])
          : null,
      };
    },

    getMessage(accessToken, messageId) {
      const url = new URL(`${graphBaseUrl}/me/messages/${encodeURIComponent(messageId)}`);
      url.searchParams.set("$select", messageFields);
      return request(fetchImpl, accessToken, url);
    },
  };
}

async function request<T>(fetchImpl: FetchLike, token: string, url: URL): Promise<T> {
  let response: Response;

  try {
    response = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${token}`,
        prefer: 'outlook.body-content-type="html"',
      },
    });
  } catch {
    throw new OutlookApiError("Microsoft Graph request failed", 0, "provider");
  }

  if (!response.ok) {
    await response.body?.cancel();
    const kind = response.status === 401 || response.status === 403
      ? "auth"
      : response.status === 429
        ? "rate_limit"
        : "provider";
    const message = kind === "auth"
      ? "Outlook authorization needs attention"
      : kind === "rate_limit"
        ? "Microsoft Graph is rate limiting requests"
        : "Microsoft Graph request failed";

    throw new OutlookApiError(message, response.status, kind);
  }

  return await response.json() as T;
}

function encodeCursor(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function decodeCursor(value: string): URL {
  try {
    const url = new URL(Buffer.from(value, "base64url").toString());
    const isGraphMessagePage = url.origin === "https://graph.microsoft.com"
      && url.pathname.startsWith("/v1.0/")
      && url.pathname.endsWith("/messages");

    if (!isGraphMessagePage) throw new Error("Unexpected Graph cursor URL");
    return url;
  } catch {
    throw new OutlookApiError("Invalid Outlook pagination cursor", 400, "provider");
  }
}
