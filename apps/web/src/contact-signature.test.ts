import { describe, expect, test } from "bun:test";
import { getContactIdentity, getContactInitials, getContactSignature } from "./contact-signature";

describe("contact identity marks", () => {
  test("derives a stable organization monogram from a structured domain", () => {
    const contact = { name: "Railway", email: "alerts@updates.railway.app" };

    expect(getContactIdentity(contact)).toEqual({ kind: "organization", label: "updates.railway.app", mark: "RA" });
    expect(getContactIdentity(contact)).toEqual(getContactIdentity({ ...contact, email: "ALERTS@UPDATES.RAILWAY.APP" }));
  });

  test("uses the registrable label for country-code domains", () => {
    expect(getContactIdentity({ name: "Vishal", email: "hello@vishal.co.uk" })).toEqual({
      kind: "organization",
      label: "vishal.co.uk",
      mark: "VI",
    });
  });

  test("keeps personal mailbox contacts on the familiar initials mark", () => {
    expect(getContactIdentity({ name: "Maya Chen", email: "maya@gmail.com" })).toEqual({
      kind: "person",
      label: "Maya Chen",
      mark: "MC",
    });
    expect(getContactInitials({ name: null, email: "maya.chen@gmail.com" })).toBe("MC");
  });

  test("falls back to the existing glyph when contact data is not usable", () => {
    expect(getContactIdentity({ name: null, email: "not-an-email" })).toEqual({
      kind: "fallback",
      label: "Unknown sender",
      mark: null,
    });
    expect(getContactSignature({ name: null, email: "not-an-email" }).variant).toBeGreaterThanOrEqual(0);
  });

  test("does not invent organization identities for reserved or generic domains", () => {
    expect(getContactIdentity({ name: "Maya Chen", email: "maya@example.com" }).kind).toBe("person");
    expect(getContactIdentity({ name: "Maya Chen", email: "maya@outlook.com" }).kind).toBe("person");
  });
});
