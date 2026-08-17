import type { CreateMessageDraft } from "@orca/shared";

import { createDatabaseClient } from "../../db/client.ts";
import { createGmailDraftClient, GmailApiError, type GmailDraftClient } from "./client.ts";
import { getGmailProviderTokens } from "./sync.ts";

type Database = ReturnType<typeof createDatabaseClient>["db"];

export type GmailDraftMirrorInput = {
  accountId: string;
  content: CreateMessageDraft;
  providerDraftId: string | null;
};

export type GmailDraftMirrorResult = {
  providerDraftId: string;
  providerMessageId: string | null;
  providerThreadId: string | null;
};

export async function mirrorGmailDraft(
  db: Database,
  input: GmailDraftMirrorInput,
  client: GmailDraftClient = createGmailDraftClient(),
): Promise<GmailDraftMirrorResult> {
  const tokens = await getGmailProviderTokens(db, input.accountId);
  if (!tokens?.accessToken) throw new Error("Gmail draft access is unavailable");

  const raw = encodeDraftMime(input.content);
  const threadId = input.content.context?.threadId ?? null;
  try {
    let draft;
    if (input.providerDraftId) {
      try {
        draft = await client.updateDraft(tokens.accessToken, input.providerDraftId, raw, threadId);
      } catch (error) {
        // The provider copy may have been removed directly in Gmail. Recreate
        // it without sacrificing the durable Orca revision.
        if (!(error instanceof GmailApiError) || error.status !== 404) throw error;
        draft = await client.createDraft(tokens.accessToken, raw, threadId);
      }
    } else {
      draft = await client.createDraft(tokens.accessToken, raw, threadId);
    }
    return {
      providerDraftId: draft.id,
      providerMessageId: draft.message?.id ?? null,
      providerThreadId: draft.message?.threadId ?? threadId,
    };
  } catch (error) {
    if (error instanceof GmailApiError) {
      throw new Error(error.status === 401 || error.status === 403
        ? "Gmail draft permission needs attention"
        : "Gmail could not mirror this draft");
    }
    throw error;
  }
}

export async function deleteGmailDraft(
  db: Database,
  accountId: string,
  providerDraftId: string,
  client: GmailDraftClient = createGmailDraftClient(),
) {
  const tokens = await getGmailProviderTokens(db, accountId);
  if (!tokens?.accessToken) throw new Error("Gmail draft access is unavailable");
  await client.deleteDraft(tokens.accessToken, providerDraftId);
}

export function encodeDraftMime(content: CreateMessageDraft) {
  const headers = [
    `To: ${formatRecipients(content.to)}`,
    ...(content.cc.length ? [`Cc: ${formatRecipients(content.cc)}`] : []),
    ...(content.bcc.length ? [`Bcc: ${formatRecipients(content.bcc)}`] : []),
    `Subject: ${encodeHeader(content.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  const mime = `${headers.join("\r\n")}\r\n\r\n${content.body.text}`;
  return Buffer.from(mime, "utf8").toString("base64url");
}

function formatRecipients(recipients: CreateMessageDraft["to"]) {
  return recipients.map((recipient) => recipient.name
    ? `"${recipient.name.replaceAll("\"", "\\\"")}" <${recipient.email}>`
    : recipient.email).join(", ");
}

function encodeHeader(value: string) {
  return /^[\x20-\x7E]*$/.test(value)
    ? value.replaceAll(/[\r\n]+/g, " ")
    : `=?UTF-8?B?${Buffer.from(value.replaceAll(/[\r\n]+/g, " "), "utf8").toString("base64")}?=`;
}
