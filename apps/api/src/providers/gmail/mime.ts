import type { MessageDraft } from "@orca/shared";

/** Builds the Gmail `raw` payload without exposing Gmail wire details to routes. */
export function encodeGmailMessage(draft: Pick<MessageDraft, "to" | "cc" | "bcc" | "subject" | "body">): string {
  const headers = [
    ...addressHeader("To", draft.to),
    ...addressHeader("Cc", draft.cc),
    ...addressHeader("Bcc", draft.bcc),
    `Subject: ${encodeHeader(draft.subject)}`,
    "MIME-Version: 1.0",
  ];
  const boundary = `orca-${crypto.randomUUID()}`;
  if (draft.body.html) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    return base64Url(`${headers.join("\r\n")}\r\n\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64(draft.body.text)}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64(draft.body.html)}\r\n--${boundary}--\r\n`);
  }
  headers.push("Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64");
  return base64Url(`${headers.join("\r\n")}\r\n\r\n${base64(draft.body.text)}\r\n`);
}

function addressHeader(name: string, recipients: Array<{ name: string | null; email: string }>) {
  if (recipients.length === 0) return [];
  return [`${name}: ${recipients.map((recipient) => recipient.name ? `${encodeHeader(recipient.name)} <${recipient.email}>` : recipient.email).join(", ")}`];
}

function encodeHeader(value: string) {
  return /[^\x20-\x7e]/.test(value) ? `=?UTF-8?B?${base64(value)}?=` : value.replace(/[\r\n]/g, " ");
}

function base64(value: string) { return Buffer.from(value, "utf8").toString("base64"); }
function base64Url(value: string) { return base64(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
