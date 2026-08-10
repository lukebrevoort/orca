import { createHmac, timingSafeEqual } from "node:crypto";

import type { GraphMessage } from "./types.ts";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const graphOrigin = "https://graph.microsoft.com";
const graphBaseUrl = `${graphOrigin}/v1.0`;
const inboxMessagePath = "/v1.0/me/mailFolders/inbox/messages";
const cursorVersion = "v1";
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
      const url = cursor === undefined || cursor === null
        ? new URL(`${graphOrigin}${inboxMessagePath}`)
        : decodeCursor(cursor, accessToken);

      if (cursor === undefined || cursor === null) {
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
          ? encodeCursor(response["@odata.nextLink"], accessToken)
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

function encodeCursor(value: string, accessToken: string): string {
  try {
    const url = new URL(value);
    assertInboxMessagePage(url);

    // The access token is the mailbox identity available to this low-level
    // contract, so bind every cursor to the token that received the page.
    const payload = Buffer.from(value, "utf8").toString("base64url");
    const signedPayload = `${cursorVersion}.${payload}`;
    const signature = createHmac("sha256", accessToken)
      .update(signedPayload)
      .digest("base64url");

    return `${signedPayload}.${signature}`;
  } catch {
    throw invalidCursorError();
  }
}

function decodeCursor(value: string, accessToken: string): URL {
  try {
    const parts = value.split(".");
    const [version, payload, signature] = parts;
    if (
      parts.length !== 3
      || version !== cursorVersion
      || !isBase64UrlSegment(payload)
      || !isBase64UrlSegment(signature)
    ) {
      throw new Error("Malformed Outlook cursor");
    }

    const signedPayload = `${version}.${payload}`;
    const expectedSignature = createHmac("sha256", accessToken)
      .update(signedPayload)
      .digest();
    const providedSignature = Buffer.from(signature, "base64url");

    if (
      providedSignature.length !== expectedSignature.length
      || !timingSafeEqual(providedSignature, expectedSignature)
    ) {
      throw new Error("Outlook cursor signature mismatch");
    }

    const encodedUrl = Buffer.from(payload, "base64url").toString("utf8");
    if (Buffer.from(encodedUrl, "utf8").toString("base64url") !== payload) {
      throw new Error("Non-canonical Outlook cursor payload");
    }

    const url = new URL(encodedUrl);
    assertInboxMessagePage(url);
    return url;
  } catch {
    throw invalidCursorError();
  }
}

function assertInboxMessagePage(url: URL): void {
  if (
    url.origin !== graphOrigin
    || url.username
    || url.password
    || url.pathname !== inboxMessagePath
    || url.hash
  ) {
    throw new Error("Unexpected Graph inbox cursor URL");
  }
}

function isBase64UrlSegment(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value);
}

function invalidCursorError(): OutlookApiError {
  return new OutlookApiError("Invalid Outlook pagination cursor", 400, "provider");
}
