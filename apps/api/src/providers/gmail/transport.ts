import type { MessageDraft } from "@orca/shared";
import { createDatabaseClient } from "../../db/client.ts";
import { encodeGmailMessage } from "./mime.ts";
import { createGmailClient, GmailApiError, type GmailTransportClient } from "./client.ts";
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

export function createGmailTransport(gmailClient: GmailTransportClient = createGmailClient()): GmailTransport {
  async function token(db: DatabaseClient, accountId: string) {
    const tokens = await readGmailProviderTokens(db, accountId);
    if (!tokens?.accessToken) throw new GmailTransportError("Gmail needs to be reconnected before mail can be delivered", "auth", false);
    return tokens.accessToken;
  }
  const threadId = (draft: MessageDraft) => draft.context?.threadId ?? null;
  return {
    async saveDraft(db, accountId, draft) {
      try {
        const accessToken = await token(db, accountId);
        const input = { accessToken, raw: encodeGmailMessage(draft), threadId: threadId(draft) };
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
        const response = await gmailClient.sendMessage({ accessToken: await token(db, accountId), raw: encodeGmailMessage(draft), threadId: threadId(draft) });
        return { providerMessageId: response.id, providerThreadId: response.threadId };
      } catch (error) { throw normalizeTransportError(error); }
    },
  };
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
