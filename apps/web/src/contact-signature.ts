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

function hashString(value: string) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash);
}

export function getContactSignature(contact: MailContact): ContactSignature {
  const key = (contact.email || contact.name || "unknown").toLowerCase();
  const hash = hashString(key);

  return {
    palette: CONTACT_PALETTES[hash % CONTACT_PALETTES.length]!,
    variant: hash % 4,
  };
}
