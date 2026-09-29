export type NotificationMessage = {
  accountId: string;
  threadId: string;
  fromName: string | null;
  fromAddress: string | null;
  subject: string | null;
  snippet: string | null;
  bodyText: string | null;
};

function preview(value: string | null, limit: number) {
  const text = (value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ").trim();
  const characters = Array.from(text);
  return characters.length > limit ? characters.slice(0, limit - 1).join("") + "…" : text;
}

/** Use only plain-text mail fields; never include raw HTML, attachments, or recipients. */
export function notificationPayload(message: NotificationMessage) {
  return {
    aps: {
      alert: {
        title: preview(message.fromName, 80) || preview(message.fromAddress, 80) || "New email",
        subtitle: preview(message.subject, 120) || "(No subject)",
        body: preview(message.snippet, 240) || preview(message.bodyText, 240) || "Open Orca to read this message.",
      },
      sound: "default",
    },
    version: 1,
    accountId: message.accountId,
    threadId: message.threadId,
  };
}
