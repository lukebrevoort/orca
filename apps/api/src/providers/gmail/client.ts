import type { GmailLabel, GmailMessage } from "./types.ts";

const gmailApiBaseUrl = "https://gmail.googleapis.com/gmail/v1/users/me";
const defaultPageSize = 25;

type GmailListMessagesResponse = {
  messages?: Array<{
    id: string;
    threadId: string;
  }>;
  nextPageToken?: string;
};

export type GmailMessagePage = {
  messageIds: string[];
  nextCursor: string | null;
};

export type GmailClient = {
  getMessage(accessToken: string, messageId: string): Promise<GmailMessage>;
  listInboxMessagePage(input: {
    accessToken: string;
    cursor?: string | null;
    pageSize?: number;
    since: Date;
  }): Promise<GmailMessagePage>;
  listLabels(accessToken: string): Promise<GmailLabel[]>;
};

export class GmailApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GmailApiError";
  }
}

export function createGmailClient(fetchImpl: typeof fetch = fetch): GmailClient {
  return {
    async getMessage(accessToken, messageId) {
      return gmailRequest<GmailMessage>(fetchImpl, accessToken, `/messages/${messageId}?format=full`);
    },

    async listInboxMessagePage({ accessToken, cursor, pageSize = defaultPageSize, since }) {
      const params = new URLSearchParams({
        includeSpamTrash: "false",
        maxResults: String(pageSize),
      });

      const query = buildInboxQuery(since);
      if (query) {
        params.set("q", query);
      }

      if (cursor) {
        params.set("pageToken", cursor);
      }

      const response = await gmailRequest<GmailListMessagesResponse>(
        fetchImpl,
        accessToken,
        `/messages?${params.toString()}`,
      );

      return {
        messageIds: (response.messages ?? []).map((message) => message.id),
        nextCursor: response.nextPageToken ?? null,
      };
    },

    async listLabels(accessToken) {
      const response = await gmailRequest<{ labels?: GmailLabel[] }>(
        fetchImpl,
        accessToken,
        "/labels",
      );

      return response.labels ?? [];
    },
  };
}

async function gmailRequest<T>(
  fetchImpl: typeof fetch,
  accessToken: string,
  path: string,
): Promise<T> {
  const response = await fetchImpl(`${gmailApiBaseUrl}${path}`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new GmailApiError("Gmail API request failed", response.status);
  }

  return (await response.json()) as T;
}

function buildInboxQuery(since: Date) {
  if (since.getTime() <= 0) {
    return null;
  }

  const unixSeconds = Math.floor(since.getTime() / 1000);
  return `after:${unixSeconds}`;
}
