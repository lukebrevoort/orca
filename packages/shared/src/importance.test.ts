import { test, expect } from "bun:test";
import { importanceAddressSchema, importanceMutationSchema, importanceResolutionSchema, importantQuerySchema } from "./importance.ts";
import { importanceResolutionFixtures } from "./importance-fixtures.ts";

test("importance contracts preserve explicit Not important, Unreviewed, reset revision and participant provenance", () => {
  for (const fixture of importanceResolutionFixtures) expect(importanceResolutionSchema.parse(fixture)).toEqual(fixture);
  expect(importanceAddressSchema.parse(" ROBOT@example.com ")).toBe("robot@example.com");
  for (const address of ["example.com", "*@example.com", "Name <a@example.com>"]) expect(importanceAddressSchema.safeParse(address).success).toBe(false);
  const command = { accountId: "a", target: { kind: "conversation", threadId: "t" }, choice: null, operationId: "9b0fb6c0-201c-4d6e-b09a-409695f3bbc3", expectedRevision: 4 };
  expect(importanceMutationSchema.parse(command).choice).toBeNull();
  for (const choice of ["unreviewed", "human", "focus"]) expect(importanceMutationSchema.safeParse({ ...command, choice }).success).toBe(false);
  expect(importanceMutationSchema.safeParse({ ...command, expectedRevision: -1 }).success).toBe(false);
  expect(importanceMutationSchema.safeParse({ ...command, providerMove: true }).success).toBe(false);
  expect(importantQuerySchema.safeParse({ accountId: "a", limit: 101 }).success).toBe(false);
});
