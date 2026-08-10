import type {
  MailAttachment,
  MailContact,
  NormalizedLabel,
  NormalizedMessage,
  NormalizedThread,
} from "@orca/shared";
import type {
  GmailHeader,
  GmailLabel,
  GmailMessage,
  GmailMessagePart,
} from "./types.ts";

type NormalizeOptions = {
  accountId: string;
};

export type NormalizedGmailMessage = NormalizedMessage & {
  attachments: MailAttachment[];
};

export function normalizeGmailMessage(
  message: GmailMessage,
  options: NormalizeOptions,
): NormalizedGmailMessage {
  const headers = getHeaders(message.payload);
  const subject = headers.get("subject") ?? "(No subject)";
  const receivedAt = normalizeInternalDate(message.internalDate);
  const labelIds = message.labelIds ?? [];

  return {
    id: buildProviderScopedId(options.accountId, message.id),
    accountId: options.accountId,
    provider: "gmail",
    providerMessageId: message.id,
    threadId: buildProviderScopedId(options.accountId, message.threadId),
    from: parseContact(headers.get("from")),
    to: parseContactList(headers.get("to")),
    cc: parseContactList(headers.get("cc")),
    bcc: parseContactList(headers.get("bcc")),
    subject,
    snippet: message.snippet ?? "",
    receivedAt,
    unread: labelIds.includes("UNREAD"),
    labels: labelIds,
    bodyText: findBodyPart(message.payload, "text/plain"),
    bodyHtml: findBodyPart(message.payload, "text/html"),
    internetMessageId: headers.get("message-id")?.trim() || null,
    references: parseReferences(headers.get("references")),
    attachments: findAttachments(message.payload, options.accountId, message.id),
    raw: {
      provider: "gmail",
      accountId: options.accountId,
      messageId: message.id,
      threadId: message.threadId,
      labelIds,
    },
  };
}

function parseReferences(value: string | undefined): string[] {
  if (!value) return [];
  return value.match(/<[^<>]+>/g) ?? value.split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

function findAttachments(
  part: GmailMessagePart | undefined,
  accountId: string,
  messageId: string,
): MailAttachment[] {
  if (!part) return [];

  const attachment = part.filename && part.body?.attachmentId
    ? [{
      id: `gmail:${accountId}:${messageId}:attachment:${part.body.attachmentId}`,
      filename: part.filename,
      mimeType: part.mimeType ?? "application/octet-stream",
      size: part.body.size ?? 0,
    }]
    : [];

  return [...attachment, ...(part.parts ?? []).flatMap((child) => findAttachments(child, accountId, messageId))];
}

export function normalizeGmailThread(messages: NormalizedMessage[]): NormalizedThread {
  const sorted = [...messages].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  const latest = sorted.at(-1);

  if (!latest) {
    throw new Error("Cannot normalize an empty Gmail thread");
  }

  return {
    id: latest.threadId,
    provider: "gmail",
    providerThreadId: latest.raw.threadId,
    subject: latest.subject,
    latestReceivedAt: latest.receivedAt,
    messageCount: messages.length,
    labels: [...new Set(messages.flatMap((message) => message.labels))],
  };
}

export function normalizeGmailLabel(label: GmailLabel): NormalizedLabel {
  return {
    id: `gmail:${label.id}`,
    provider: "gmail",
    providerLabelId: label.id,
    name: label.name,
    type: label.type ?? inferGmailLabelType(label.id),
  };
}

function getHeaders(payload: GmailMessagePart | undefined): Map<string, string> {
  return new Map(
    (payload?.headers ?? []).map((header: GmailHeader) => [
      header.name.toLowerCase(),
      header.value,
    ]),
  );
}

function normalizeInternalDate(internalDate: string | undefined): string {
  if (!internalDate) {
    return new Date(0).toISOString();
  }

  const timestamp = Number(internalDate);
  return new Date(Number.isFinite(timestamp) ? timestamp : Date.parse(internalDate)).toISOString();
}

function findBodyPart(part: GmailMessagePart | undefined, mimeType: string): string | null {
  if (!part) {
    return null;
  }

  if (part.mimeType === mimeType && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }

  for (const child of part.parts ?? []) {
    const result = findBodyPart(child, mimeType);
    if (result) {
      return result;
    }
  }

  return null;
}

function parseContactList(value: string | undefined): MailContact[] {
  if (!value) {
    return [];
  }

  return value.split(",").map(parseContact);
}

function parseContact(value: string | undefined): MailContact {
  if (!value) {
    return { name: null, email: "" };
  }

  const match = value.match(/^(?:"?([^"<]*)"?)?\s*<([^>]+)>$/);
  if (!match) {
    return { name: null, email: value.trim() };
  }

  const [, name, email] = match;
  return {
    name: name?.trim() || null,
    email: email.trim(),
  };
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString(
    "utf8",
  );
}

function inferGmailLabelType(labelId: string): "system" | "user" {
  return /^[A-Z_]+$/.test(labelId) ? "system" : "user";
}

function buildProviderScopedId(accountId: string, providerId: string): string {
  return `gmail:${accountId}:${providerId}`;
}
