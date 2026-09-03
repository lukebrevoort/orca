import { describe, expect, test } from "bun:test";

import { authProviderAvailabilitySchema } from "./schemas.ts";

describe("auth provider availability", () => {
  test("accepts only the public configured and configuration-required states", () => {
    expect(authProviderAvailabilitySchema.parse({ provider: "gmail", available: true, reason: null })).toEqual({ provider: "gmail", available: true, reason: null });
    expect(authProviderAvailabilitySchema.parse({ provider: "outlook", available: false, reason: "configuration_required" })).toEqual({ provider: "outlook", available: false, reason: "configuration_required" });
    expect(authProviderAvailabilitySchema.safeParse({ provider: "gmail", available: false, reason: "GMAIL_CLIENT_SECRET" }).success).toBe(false);
    expect(authProviderAvailabilitySchema.safeParse({ provider: "outlook", available: true, reason: "configuration_required" }).success).toBe(false);
  });
});
