import type { MailCapabilities } from "@orca/shared";

export function detectOutlookCapabilities(scopes: string | string[] | null): MailCapabilities {
  const granted = new Set((Array.isArray(scopes) ? scopes : scopes?.split(/\s+/) ?? []).map((scope) => scope.toLowerCase()));
  return {
    read: granted.has("mail.read") || granted.has("mail.readwrite"),
    draft: granted.has("mail.readwrite"),
    send: granted.has("mail.send"),
  };
}
