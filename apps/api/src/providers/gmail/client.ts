import type { GmailLabel, GmailMessage } from "./types.ts";

const gmailApiBaseUrl = "https://gmail.googleapis.com/gmail/v1/users/me";
const defaultPageSize = 25;
// Gmail's `after:` search is exclusive, while the local checkpoint is a
// wall-clock high-water mark. Re-read a small window so a message accepted at
// the boundary (or indexed just after the checkpoint) cannot be skipped.
const incrementalSyncOverlapMs = 60_000;

type GmailListMessagesResponse = {
  messages?: Array<{
    id: string;
    threadId: string;
  }>;
  nextPageToken?: string;
};

type GmailHistoryRecord = {
  messagesAdded?: Array<{ message?: { id?: string; threadId?: string } }>;
  messagesDeleted?: Array<{ message?: { id?: string; threadId?: string } }>;
  labelsAdded?: Array<{ message?: { id?: string; threadId?: string } }>;
  labelsRemoved?: Array<{ message?: { id?: string; threadId?: string } }>;
};

type GmailHistoryResponse = {
  history?: GmailHistoryRecord[];
  historyId?: string | number;
  nextPageToken?: string;
};

export type GmailWatchResponse = {
  historyId: string | number;
  expiration: string | number;
};

export type GmailHistoryPage = {
  messageIds: string[];
  deletedMessageIds: string[];
  nextCursor: string | null;
  historyId: string | null;
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
  listHistory?(input: {
    accessToken: string;
    startHistoryId: string;
    cursor?: string | null;
    pageSize?: number;
  }): Promise<GmailHistoryPage>;
  watch?(accessToken: string, topicName: string): Promise<GmailWatchResponse>;
};

export type GmailDraft = {
  id: string;
  message?: {
    id?: string;
    threadId?: string;
  };
};

export type GmailDraftClient = {
  createDraft(accessToken: string, raw: string, threadId?: string | null): Promise<GmailDraft>;
  updateDraft(accessToken: string, draftId: string, raw: string, threadId?: string | null): Promise<GmailDraft>;
  deleteDraft(accessToken: string, draftId: string): Promise<void>;
};

export type GmailTransportClient = {
  createDraft(input: { accessToken: string; raw: string; threadId?: string | null }): Promise<GmailDraftResponse>;
  updateDraft(input: { accessToken: string; draftId: string; raw: string; threadId?: string | null }): Promise<GmailDraftResponse>;
  deleteDraft(accessToken: string, draftId: string): Promise<void>;
  sendMessage(input: { accessToken: string; raw: string; threadId?: string | null }): Promise<GmailSentMessage>;
};

export type GmailDraftResponse = { id: string; message: GmailSentMessage };
export type GmailSentMessage = { id: string; threadId: string };

export class GmailApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GmailApiError";
  }
}

export function createGmailClient(fetchImpl: typeof fetch = fetch): GmailClient & GmailTransportClient {
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

    async listHistory({ accessToken, startHistoryId, cursor, pageSize = defaultPageSize }) {
      const params = new URLSearchParams({
        startHistoryId,
        maxResults: String(pageSize),
      });

      if (cursor) {
        params.set("pageToken", cursor);
      }

      // A push notification does not identify whether the change was a new
      // message or a label/read-state update. Ask for every history type so
      // the local normalized copy is refreshed in either case.
      for (const historyType of ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]) {
        params.append("historyTypes", historyType);
      }

      const response = await gmailRequest<GmailHistoryResponse>(
        fetchImpl,
        accessToken,
        `/history?${params.toString()}`,
      );

      const messageChanges = new Map<string, "changed" | "deleted">();
      for (const record of response.history ?? []) {
        for (const entry of [
          ...(record.messagesAdded ?? []),
          ...(record.labelsAdded ?? []),
          ...(record.labelsRemoved ?? []),
        ]) {
          if (entry.message?.id) messageChanges.set(entry.message.id, "changed");
        }
        for (const entry of record.messagesDeleted ?? []) {
          if (entry.message?.id) messageChanges.set(entry.message.id, "deleted");
        }
      }

      return {
        messageIds: [...messageChanges].filter(([, change]) => change === "changed").map(([id]) => id),
        deletedMessageIds: [...messageChanges].filter(([, change]) => change === "deleted").map(([id]) => id),
        nextCursor: response.nextPageToken ?? null,
        historyId: response.historyId === undefined ? null : String(response.historyId),
      };
    },

    async watch(accessToken, topicName) {
      return gmailRequest<GmailWatchResponse>(fetchImpl, accessToken, "/watch", {
        method: "POST",
        body: {
          topicName,
          labelIds: ["INBOX"],
          labelFilterBehavior: "INCLUDE",
        },
      });
    },

    async createDraft({ accessToken, raw, threadId }) {
      return gmailRequest<GmailDraftResponse>(fetchImpl, accessToken, "/drafts", {
        method: "POST", body: { message: { raw, ...(threadId ? { threadId } : {}) } },
      });
    },

    async updateDraft({ accessToken, draftId, raw, threadId }) {
      return gmailRequest<GmailDraftResponse>(fetchImpl, accessToken, `/drafts/${draftId}`, {
        method: "PUT", body: { id: draftId, message: { raw, ...(threadId ? { threadId } : {}) } },
      });
    },

    async deleteDraft(accessToken, draftId) {
      await gmailRequest<void>(fetchImpl, accessToken, `/drafts/${draftId}`, { method: "DELETE" });
    },

    async sendMessage({ accessToken, raw, threadId }) {
      return gmailRequest<GmailSentMessage>(fetchImpl, accessToken, "/messages/send", {
        method: "POST", body: { raw, ...(threadId ? { threadId } : {}) },
      });
    },
  };
}

export function createGmailDraftClient(fetchImpl: typeof fetch = fetch): GmailDraftClient {
  return {
    createDraft(accessToken, raw, threadId) {
      return gmailMutation<GmailDraft>(fetchImpl, accessToken, "/drafts", "POST", {
        message: { raw, ...(threadId ? { threadId } : {}) },
      });
    },

    updateDraft(accessToken, draftId, raw, threadId) {
      return gmailMutation<GmailDraft>(fetchImpl, accessToken, `/drafts/${encodeURIComponent(draftId)}`, "PUT", {
        id: draftId,
        message: { raw, ...(threadId ? { threadId } : {}) },
      });
    },

    async deleteDraft(accessToken, draftId) {
      await gmailMutation<undefined>(fetchImpl, accessToken, `/drafts/${encodeURIComponent(draftId)}`, "DELETE");
    },
  };
}

async function gmailRequest<T>(
  fetchImpl: typeof fetch,
  accessToken: string,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetchImpl(`${gmailApiBaseUrl}${path}`, {
    method: options.method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (!response.ok) {
    throw new GmailApiError("Gmail API request failed", response.status);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function gmailMutation<T>(
  fetchImpl: typeof fetch,
  accessToken: string,
  path: string,
  method: "POST" | "PUT" | "DELETE",
  body?: unknown,
): Promise<T> {
  const response = await fetchImpl(`${gmailApiBaseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!response.ok) {
    throw new GmailApiError("Gmail draft request failed", response.status);
  }

  return response.status === 204 ? undefined as T : await response.json() as T;
}

function buildInboxQuery(since: Date) {
  const querySince = Math.max(0, since.getTime() - incrementalSyncOverlapMs);
  if (querySince <= 0) {
    return null;
  }

  const unixSeconds = Math.floor(querySince / 1000);
  return `after:${unixSeconds}`;
}
