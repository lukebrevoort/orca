import type { MailCapabilities } from "@orca/shared";

const gmailScopes = {
  full: "https://mail.google.com/",
  modify: "https://www.googleapis.com/auth/gmail.modify",
  readonly: "https://www.googleapis.com/auth/gmail.readonly",
  compose: "https://www.googleapis.com/auth/gmail.compose",
  send: "https://www.googleapis.com/auth/gmail.send",
} as const;

export function detectGmailCapabilities(scopes: string | string[] | null): MailCapabilities {
  // Scope was nullable before capability reporting existed. Those legacy rows
  // represent the original read-only Gmail connection rather than no grant.
  if (scopes === null) {
    return { read: true, draft: false, send: false };
  }
  const granted = new Set(
    (Array.isArray(scopes) ? scopes : scopes?.split(/\s+/) ?? []).filter(Boolean),
  );
  const broadMailboxAccess = granted.has(gmailScopes.full) || granted.has(gmailScopes.modify);
  const composeAccess = broadMailboxAccess || granted.has(gmailScopes.compose);

  return {
    read: broadMailboxAccess || granted.has(gmailScopes.readonly),
    draft: composeAccess,
    send: composeAccess || granted.has(gmailScopes.send),
  };
}
