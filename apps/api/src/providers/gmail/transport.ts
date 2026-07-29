import type { MessageDraft } from "@orca/shared";
import { createDatabaseClient } from "../../db/client.ts";
import { encodeGmailMessage } from "./mime.ts";
import { createGmailClient, GmailApiError, type GmailClient, type GmailTransportClient } from "./client.ts";
import { readGmailProviderTokens } from "./sync.ts";

type DatabaseClient = ReturnType<typeof createDatabaseClient>["db"];

export class GmailTransportError extends Error {
  constructor(
    message: string,
    readonly kind: "auth" | "rate_limit" | "rejected" | "ambiguous",
    readonly retryable: boolean,
  ) { super(message); this.name = "GmailTransportError"; }
}

export type GmailTransport = {
  saveDraft(db: DatabaseClient, accountId: string, draft: MessageDraft): Promise<{ providerDraftId: string }>;
  deleteDraft(db: DatabaseClient, accountId: string, providerDraftId: string): Promise<void>;
  send(db: DatabaseClient, accountId: string, draft: MessageDraft): Promise<{ providerMessageId: string; providerThreadId: string }>;
};

type GmailThreadingClient = GmailTransportClient & Partial<Pick<GmailClient, "getMessage">>;

export function createGmailTransport(gmailClient: GmailThreadingClient = createGmailClient()): GmailTransport {
  async function token(db: DatabaseClient, accountId: string) {
    const tokens = await readGmailProviderTokens(db, accountId);
    if (!tokens?.accessToken) throw new GmailTransportError("Gmail needs to be reconnected before mail can be delivered", "auth", false);
    return tokens.accessToken;
  }
  const threadId = (draft: MessageDraft) =>
    draft.context && draft.context.kind !== "forward" ? draft.context.providerThreadId : null;
  async function withThreadingHeaders(draft: MessageDraft, accessToken: string): Promise<MessageDraft> {
    return hydrateGmailThreadingHeaders(draft, async (providerMessageId) => {
      if (!gmailClient.getMessage) throw new GmailTransportError("Gmail threading metadata is unavailable", "rejected", false);
      return gmailClient.getMessage(accessToken, providerMessageId);
    });
  }
  return {
    async saveDraft(db, accountId, draft) {
      try {
        const accessToken = await token(db, accountId);
        const threadedDraft = await withThreadingHeaders(draft, accessToken);
        const input = { accessToken, raw: encodeGmailMessage(threadedDraft), threadId: threadId(threadedDraft) };
        const response = draft.providerDraftId
          ? await gmailClient.updateDraft({ ...input, draftId: draft.providerDraftId })
          : await gmailClient.createDraft(input);
        return { providerDraftId: response.id };
      } catch (error) { throw normalizeTransportError(error); }
    },
    async deleteDraft(db, accountId, providerDraftId) {
      try { await gmailClient.deleteDraft(await token(db, accountId), providerDraftId); }
      catch (error) { throw normalizeTransportError(error); }
    },
    async send(db, accountId, draft) {
      try {
        const accessToken = await token(db, accountId);
        const threadedDraft = await withThreadingHeaders(draft, accessToken);
        const response = await gmailClient.sendMessage({ accessToken, raw: encodeGmailMessage(threadedDraft), threadId: threadId(threadedDraft) });
        return { providerMessageId: response.id, providerThreadId: response.threadId };
      } catch (error) { throw normalizeTransportError(error); }
    },
  };
}

export async function hydrateGmailThreadingHeaders(
  draft: MessageDraft,
  getMessage: (providerMessageId: string) => ReturnType<GmailClient["getMessage"]>,
): Promise<MessageDraft> {
  if (!draft.context || draft.context.kind === "forward" || draft.context.inReplyTo) return draft;
  const source = await getMessage(draft.context.providerMessageId);
  const headers = new Map((source.payload?.headers ?? []).map((header) => [header.name.toLowerCase(), header.value.trim()]));
  return {
    ...draft,
    context: {
      ...draft.context,
      inReplyTo: headers.get("message-id") ?? null,
      references: parseReferences(headers.get("references")),
    },
  };
}

function parseReferences(value: string | undefined) {
  if (!value) return [];
  return value.match(/<[^<>\r\n]+>/g) ?? [];
}

function normalizeTransportError(error: unknown): GmailTransportError {
  if (error instanceof GmailTransportError) return error;
  if (error instanceof GmailApiError) {
    if (error.status === 401 || error.status === 403) return new GmailTransportError("Gmail authorization was revoked or no longer permits this action", "auth", false);
    if (error.status === 429) return new GmailTransportError("Gmail is rate limiting delivery; retry later", "rate_limit", true);
    if (error.status >= 400 && error.status < 500) return new GmailTransportError("Gmail rejected this message", "rejected", false);
    return new GmailTransportError("Gmail did not confirm whether it accepted this message", "ambiguous", true);
  }
  return new GmailTransportError("The delivery outcome could not be confirmed", "ambiguous", true);
}
