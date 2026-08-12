import type { MailContact, NormalizedMessage } from "@orca/shared";
import { buildHumanClassificationEvidence } from "../../classification/evidence.ts";
import type { GraphContact, GraphMessage } from "./types.ts";

export function normalizeOutlookMessage(
  message: GraphMessage,
  options: { accountId: string; accountEmail?: string | null },
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
  const from = contact(message.from);
  const to = (message.toRecipients ?? []).map(contact);
  const cc = (message.ccRecipients ?? []).map(contact);
  const bcc = (message.bccRecipients ?? []).map(contact);

  return {
    id: `outlook:${options.accountId}:${message.id}`,
    accountId: options.accountId,
    provider: "outlook",
    providerMessageId: message.id,
    threadId: `outlook:${options.accountId}:${threadId}`,
    from,
    to,
    cc,
    bcc,
    subject: message.subject ?? "(No subject)",
    snippet: message.bodyPreview ?? "",
    receivedAt: validDate(message.receivedDateTime),
    unread: !message.isRead,
    labels: message.categories ?? [],
    bodyText: text,
    bodyHtml: html,
    internetMessageId: message.internetMessageId ?? null,
    references: parseReferences(headers.get("references")),
    classificationEvidence: buildHumanClassificationEvidence({
      sender: from,
      recipients: [...to, ...cc, ...bcc],
      accountEmail: options.accountEmail,
      headers,
      providerSignals: outlookProviderSignals(message.categories ?? []),
    }),
    raw: {
      provider: "outlook",
      accountId: options.accountId,
      messageId: message.id,
      threadId,
      labelIds: message.categories ?? [],
    },
  };
}

function outlookProviderSignals(categories: string[]) {
  const signals = new Set<"bulk_or_marketing_label" | "promotions_label" | "transactional_category" | "automated_category">();
  for (const category of categories) {
    const normalized = category.trim().toLowerCase();
    if (/promotion|marketing/.test(normalized)) signals.add("promotions_label");
    if (/newsletter|bulk|mailing list/.test(normalized)) signals.add("bulk_or_marketing_label");
    if (/receipt|billing|transaction/.test(normalized)) signals.add("transactional_category");
    if (/automated|notification|system/.test(normalized)) signals.add("automated_category");
  }
  return [...signals];
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
