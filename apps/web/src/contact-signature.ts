import type { MailContact } from "@orca/shared";

export type ContactPalette = {
  rail: string;
  bg: string;
  fg: string;
};

export type ContactSignature = {
  palette: ContactPalette;
  variant: number;
};

export type ContactIdentity =
  | { kind: "organization"; label: string; mark: string }
  | { kind: "person"; label: string; mark: string }
  | { kind: "fallback"; label: "Unknown sender"; mark: null };

const CONTACT_PALETTES: ContactPalette[] = [
  { rail: "#3d6d84", bg: "rgba(61, 109, 132, 0.18)", fg: "#3d6d84" },
  { rail: "#4f7356", bg: "rgba(79, 115, 86, 0.18)", fg: "#4f7356" },
  { rail: "#8a6348", bg: "rgba(138, 99, 72, 0.18)", fg: "#8a6348" },
  { rail: "#6f5a82", bg: "rgba(111, 90, 130, 0.18)", fg: "#6f5a82" },
  { rail: "#3a6570", bg: "rgba(58, 101, 112, 0.18)", fg: "#3a6570" },
  { rail: "#7a7040", bg: "rgba(122, 112, 64, 0.18)", fg: "#7a7040" },
  { rail: "#4a5c8a", bg: "rgba(74, 92, 138, 0.18)", fg: "#4a5c8a" },
  { rail: "#845858", bg: "rgba(132, 88, 88, 0.18)", fg: "#845858" },
];

// These domains do not carry a useful organization identity on their own.
// Keep this list local and deliberately small: it prevents a personal mailbox
// provider from looking like the sender's organization without requiring a
// network lookup or a new provider field.
const GENERIC_MAIL_DOMAINS = new Set([
  "aol.com",
  "fastmail.com",
  "gmail.com",
  "googlemail.com",
  "gmx.com",
  "hey.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "mac.com",
  "mail.com",
  "me.com",
  "msn.com",
  "outlook.com",
  "proton.me",
  "protonmail.com",
  "tutanota.com",
  "yahoo.com",
  "ymail.com",
  "zoho.com",
]);

const GENERIC_MAIL_ROOTS = new Set([
  "aol",
  "fastmail",
  "gmail",
  "googlemail",
  "gmx",
  "hey",
  "hotmail",
  "icloud",
  "live",
  "mac",
  "mail",
  "me",
  "msn",
  "outlook",
  "proton",
  "protonmail",
  "tutanota",
  "yahoo",
  "ymail",
  "zoho",
]);

const RESERVED_DOMAIN_LABELS = new Set(["example", "invalid", "localhost", "test"]);
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function hashString(value: string) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash);
}

function emailParts(email: string) {
  const normalized = email.trim().toLowerCase();
  const separator = normalized.lastIndexOf("@");
  if (separator <= 0 || separator === normalized.length - 1) return null;

  return {
    local: normalized.slice(0, separator),
    domain: normalized.slice(separator + 1),
  };
}

function organizationRoot(domain: string) {
  const labels = domain.split(".");
  if (labels.length < 2 || !DOMAIN_PATTERN.test(domain)) return null;

  const tld = labels[labels.length - 1]!;
  if (RESERVED_DOMAIN_LABELS.has(tld)) return null;

  const rootIndex = tld.length === 2 && labels[labels.length - 2]!.length <= 3
    ? labels.length - 3
    : labels.length - 2;
  const root = labels[rootIndex];
  if (!root || RESERVED_DOMAIN_LABELS.has(root) || GENERIC_MAIL_ROOTS.has(root)) return null;
  if (GENERIC_MAIL_DOMAINS.has(domain)) return null;

  return root;
}

function initialsFromLabel(label: string) {
  const words = label.split(/[^a-z0-9]+/i).filter(Boolean);
  if (words.length > 1) return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();

  const compact = label.replace(/[^a-z0-9]/gi, "");
  return compact.slice(0, 2).toUpperCase();
}

export function getContactInitials(contact: MailContact) {
  const parts = emailParts(contact.email);
  const label = contact.name?.trim() || parts?.local.replace(/[._-]+/g, " ") || "";
  const initials = initialsFromLabel(label);
  return initials || null;
}

/**
 * Selects a local, deterministic identity mark for a contact. An organization
 * mark is only shown when the email has a structured non-personal domain; all
 * other usable contacts retain the familiar initials treatment.
 */
export function getContactIdentity(contact: MailContact): ContactIdentity {
  const parts = emailParts(contact.email);
  const root = parts ? organizationRoot(parts.domain) : null;

  if (root) {
    return { kind: "organization", label: parts!.domain, mark: initialsFromLabel(root) };
  }

  const initials = getContactInitials(contact);
  const label = contact.name?.trim() || parts?.local.replace(/[._-]+/g, " ").trim();
  if (initials && label) return { kind: "person", label, mark: initials };

  return { kind: "fallback", label: "Unknown sender", mark: null };
}

export function getContactSignature(contact: MailContact): ContactSignature {
  const key = (contact.email || contact.name || "unknown").toLowerCase();
  const hash = hashString(key);

  return {
    palette: CONTACT_PALETTES[hash % CONTACT_PALETTES.length]!,
    variant: hash % 4,
  };
}
