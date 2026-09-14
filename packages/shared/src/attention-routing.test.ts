import { expect, test } from "bun:test";
import { attentionRoutingChangeSchema, attentionRoutingQuerySchema, attentionSenderLookupQuerySchema } from "./attention-routing.ts";

test("routing contracts require explicit scope and revision, normalize exact addresses, and preserve advanced sender choices", () => {
  const input = { expectedRevision: 0, target: { scope: "sender", address: " MAYA@Example.com " }, behavior: "hidden" };
  expect(attentionRoutingChangeSchema.parse(input).target).toEqual({ scope: "sender", address: "maya@example.com" });
  expect(attentionRoutingChangeSchema.safeParse({ ...input, expectedRevision: -1 }).success).toBe(false);
  expect(attentionRoutingChangeSchema.safeParse({ target: input.target, behavior: "quiet" }).success).toBe(false);
  expect(attentionRoutingChangeSchema.safeParse({ ...input, target: { scope: "conversation", threadId: "T" } }).success).toBe(false);
  expect(attentionRoutingChangeSchema.safeParse({ ...input, target: { scope: "account" } }).success).toBe(false);
  expect(attentionRoutingChangeSchema.safeParse({ ...input, target: { scope: "conversation", threadId: "T" }, behavior: null }).success).toBe(true);
});

test("account queries and bounded search validate independently of notification intent", () => {
  expect(attentionRoutingQuerySchema.safeParse({ address: "maya@example.com" }).success).toBe(false);
  expect(attentionRoutingQuerySchema.parse({ accountId: "A", address: "MAYA@example.com" }).address).toBe("maya@example.com");
  expect(attentionSenderLookupQuerySchema.parse({ accountId: "A" }).query).toBe("");
  expect(attentionSenderLookupQuerySchema.safeParse({ accountId: "A", query: "x".repeat(201) }).success).toBe(false);
});
