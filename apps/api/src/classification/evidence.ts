import type {
  HumanClassificationEvidence,
  HumanClassificationHeaderSignal,
  HumanClassificationProviderSignal,
  MailContact,
} from "@orca/shared";

export function buildHumanClassificationEvidence(input: {
  sender: MailContact;
  recipients: MailContact[];
  accountEmail?: string | null;
  headers: ReadonlyMap<string, string>;
  providerSignals: HumanClassificationProviderSignal[];
}): HumanClassificationEvidence {
  const references = parseReferences(input.headers.get("references"));

  return {
    sender: input.sender,
    recipients: input.recipients,
    recipientRelationship: recipientRelationship(input.accountEmail, input.recipients),
    reply: {
      hasInReplyTo: hasHeader(input.headers, "in-reply-to"),
      referenceCount: references.length,
    },
    headerSignals: headerSignals(input.headers),
    providerSignals: [...new Set(input.providerSignals)],
  };
}

function headerSignals(headers: ReadonlyMap<string, string>): HumanClassificationHeaderSignal[] {
  const signals = new Set<HumanClassificationHeaderSignal>();
  if (hasHeader(headers, "list-id")) signals.add("list_id");
  if (hasHeader(headers, "list-unsubscribe")) signals.add("list_unsubscribe");
  const precedence = headers.get("precedence")?.trim().toLowerCase();
  if (precedence === "bulk") signals.add("precedence_bulk");
  if (precedence === "list") signals.add("precedence_list");
  // RFC 3834 explicitly uses "no" to say the message was not generated
  // automatically. X-Auto-Response-Suppress only controls recipient replies,
  // so neither is evidence that the original sender is automated.
  const autoSubmitted = headers.get("auto-submitted")?.trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") signals.add("auto_submitted");
  return [...signals];
}

function recipientRelationship(
  accountEmail: string | null | undefined,
  recipients: MailContact[],
): HumanClassificationEvidence["recipientRelationship"] {
  const normalizedAccount = accountEmail?.trim().toLowerCase();
  if (!normalizedAccount) return "unknown";
  return recipients.some((recipient) => recipient.email.trim().toLowerCase() === normalizedAccount)
    ? "direct"
    : "not_direct";
}

function hasHeader(headers: ReadonlyMap<string, string>, name: string): boolean {
  return Boolean(headers.get(name)?.trim());
}

function parseReferences(value: string | undefined): string[] {
  if (!value) return [];
  return value.match(/<[^<>]+>/g)
    ?? value.split(/\s+/).map((item) => item.trim()).filter(Boolean);
}
