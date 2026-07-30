import type { MessageDraft } from "@orca/shared";

/** Builds the Gmail `raw` payload without exposing Gmail wire details to routes. */
export function encodeGmailMessage(draft: Pick<MessageDraft, "to" | "cc" | "bcc" | "subject" | "body" | "context" | "attachments">): string {
  const headers = [
    ...addressHeader("To", draft.to),
    ...addressHeader("Cc", draft.cc),
    ...addressHeader("Bcc", draft.bcc),
    foldHeader("Subject", encodeUnstructuredHeader(draft.subject)),
    ...replyHeaders(draft.context),
    "MIME-Version: 1.0",
  ];
  const body = bodyEntity(draft.body);
  if (!draft.attachments.length) return base64Url(`${headers.join("\r\n")}\r\n${body}`);
  const boundary = `orca-mixed-${crypto.randomUUID()}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [
    body,
    ...draft.attachments.map((attachment) => attachmentEntity(attachment)),
  ];
  return base64Url(`${headers.join("\r\n")}\r\n\r\n${parts.map((part) => `--${boundary}\r\n${part}`).join("\r\n")}--${boundary}--\r\n`);
}

function bodyEntity(body: MessageDraft["body"]) {
  if (!body.html) return `Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${foldBase64(base64(body.text))}\r\n`;
  const boundary = `orca-alt-${crypto.randomUUID()}`;
  return `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${foldBase64(base64(body.text))}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${foldBase64(base64(body.html))}\r\n--${boundary}--\r\n`;
}

function attachmentEntity(attachment: MessageDraft["attachments"][number]) {
  if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(attachment.mimeType)) {
    throw new Error("Invalid attachment media type");
  }
  const filename = attachment.filename.replace(/[\r\n]/g, "_");
  const asciiFilename = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "\\$&");
  return `${foldHeader("Content-Type", `${attachment.mimeType}; name="${asciiFilename}"`)}\r\n${foldHeader("Content-Disposition", `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`)}\r\nContent-Transfer-Encoding: base64\r\n\r\n${foldBase64(attachment.contentBase64 ?? "")}\r\n`;
}

function foldBase64(value: string) {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function replyHeaders(context: MessageDraft["context"]) {
  if (!context || context.kind === "forward" || !context.inReplyTo) return [];
  const references = [...context.references, context.inReplyTo]
    .filter((value, index, values) => values.indexOf(value) === index);
  return [
    foldHeader("In-Reply-To", context.inReplyTo),
    foldHeader("References", references.join(" ")),
  ];
}

function addressHeader(name: string, recipients: Array<{ name: string | null; email: string }>) {
  if (recipients.length === 0) return [];
  const value = recipients.map((recipient) => recipient.name ? `${encodeDisplayName(recipient.name)} <${recipient.email}>` : recipient.email).join(", ");
  return [foldHeader(name, value)];
}

function encodeDisplayName(value: string) {
  const safe = sanitizeHeaderText(value);
  if (/[^\x20-\x7e]/.test(safe)) return encodeWords(safe);
  return `"${safe.replace(/["\\]/g, "\\$&")}"`;
}

function encodeUnstructuredHeader(value: string) {
  const safe = sanitizeHeaderText(value);
  return /[^\x20-\x7e]/.test(safe) ? encodeWords(safe) : safe;
}

function encodeWords(value: string) {
  const chunks: string[] = [];
  let chunk = "";
  for (const character of value) {
    if (Buffer.byteLength(chunk + character, "utf8") > 30 && chunk) {
      chunks.push(chunk);
      chunk = character;
    } else {
      chunk += character;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((part) => `=?UTF-8?B?${base64(part)}?=`).join(" ");
}

function sanitizeHeaderText(value: string) {
  return value.replace(/[\r\n]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function foldHeader(name: string, value: string) {
  const prefix = `${name}: `;
  const words = value.split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = prefix;
  for (const word of words) {
    const separator = line === prefix ? "" : " ";
    if (Buffer.byteLength(line + separator + word, "utf8") > 78 && line !== prefix) {
      lines.push(line);
      line = ` ${word}`;
    } else {
      line += separator + word;
    }
  }
  lines.push(line);
  if (lines.some((candidate) => Buffer.byteLength(candidate, "utf8") > 998)) throw new Error(`${name} header exceeds RFC line limit`);
  return lines.join("\r\n");
}

function base64(value: string) { return Buffer.from(value, "utf8").toString("base64"); }
function base64Url(value: string) { return base64(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
