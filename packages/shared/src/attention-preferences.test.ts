import { expect, test } from "bun:test";
import { updateAttentionPreferencesSchema } from "./attention-preferences";

const input = { expectedRevision: 0, defaultChoice: "quiet", senders: [] };

test("sender addresses normalize before duplicate validation", () => {
  const sender = { address: "  MAYA@example.com ", choice: "notify" };
  expect(updateAttentionPreferencesSchema.parse({ ...input, senders: [sender] }).senders[0]!.address).toBe("maya@example.com");
  expect(updateAttentionPreferencesSchema.safeParse({ ...input, senders: [sender, { ...sender, address: "maya@example.com" }] }).success).toBe(false);
});

test("preferences reject invalid addresses, unsafe revisions, and more than 1000 senders", () => {
  for (const address of ["not-email", "@example.com", "maya@example.com,alex@example.com"]) {
    expect(updateAttentionPreferencesSchema.safeParse({ ...input, senders: [{ address, choice: "notify" }] }).success).toBe(false);
  }
  for (const expectedRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER]) {
    expect(updateAttentionPreferencesSchema.safeParse({ ...input, expectedRevision }).success).toBe(false);
  }
  const senders = Array.from({ length: 1000 }, (_, index) => ({ address: `sender${index}@example.com`, choice: "quiet" }));
  expect(updateAttentionPreferencesSchema.safeParse({ ...input, senders }).success).toBe(true);
  expect(updateAttentionPreferencesSchema.safeParse({ ...input, senders: [...senders, { address: "extra@example.com", choice: "quiet" }] }).success).toBe(false);
});
