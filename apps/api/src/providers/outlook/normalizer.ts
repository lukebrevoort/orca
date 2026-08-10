import type { MailContact, NormalizedMessage } from "@orca/shared";
import type { GraphContact, GraphMessage } from "./types.ts";

export function normalizeOutlookMessage(
  message: GraphMessage,
  options: { accountId: string },
): NormalizedMessage {
  const threadId = message.conversationId || message.id;
  const headers = new Map(
    (message.internetMessageHeaders ?? []).map((header) => [
      header.name.toLowerCase(),
      header.value,
    ]),
  );
  const html = message.body?.contentType?.toLowerCase() === "html"
    ? message.body.content ?? null
    : null;
  const text = message.body?.contentType?.toLowerCase() === "text"
    ? message.body.content ?? null
    : null;

  return {
    id: `outlook:${options.accountId}:${message.id}`,
    accountId: options.accountId,
    provider: "outlook",
    providerMessageId: message.id,
    threadId: `outlook:${options.accountId}:${threadId}`,
    from: contact(message.from),
    to: (message.toRecipients ?? []).map(contact),
    cc: (message.ccRecipients ?? []).map(contact),
    bcc: (message.bccRecipients ?? []).map(contact),
    subject: message.subject ?? "(No subject)",
    snippet: message.bodyPreview ?? "",
    receivedAt: validDate(message.receivedDateTime),
    unread: !message.isRead,
    labels: message.categories ?? [],
    bodyText: text,
    bodyHtml: html,
    internetMessageId: message.internetMessageId ?? null,
    references: parseReferences(headers.get("references")),
    raw: {
      provider: "outlook",
      accountId: options.accountId,
      messageId: message.id,
      threadId,
      labelIds: message.categories ?? [],
    },
  };
}

function contact(value: GraphContact | null | undefined): MailContact {
  return {
    name: value?.emailAddress?.name?.trim() || null,
    email: value?.emailAddress?.address?.trim() || "",
  };
}

function validDate(value: string | null | undefined): string {
  const time = value ? Date.parse(value) : NaN;
  return new Date(Number.isFinite(time) ? time : 0).toISOString();
}

function parseReferences(value: string | undefined): string[] {
  if (!value) return [];
  return value.match(/<[^<>]+>/g)
    ?? value.split(/\s+/).map((item) => item.trim()).filter(Boolean);
}
