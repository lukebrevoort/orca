import { describe, expect, test } from "bun:test";

import { gmailProvider } from "./gmail/provider.ts";
import { outlookProvider } from "./outlook/provider.ts";
import { ProviderRegistry, providerRegistry } from "./registry.ts";
import { ProviderNotImplementedError } from "./shared/interfaces.ts";

describe("provider registry", () => {
  test("registers Gmail and Outlook adapters", () => {
    expect(providerRegistry.list().map(({ provider }) => provider)).toEqual(["gmail", "outlook"]);
    expect(providerRegistry.get("gmail")).toBe(gmailProvider);
    expect(providerRegistry.get("outlook")).toBe(outlookProvider);
  });

  test("rejects duplicate registrations", () => {
    expect(() => new ProviderRegistry([gmailProvider, gmailProvider])).toThrow("gmail is already registered");
  });

  test("allows intentionally partial registries and reports missing providers", () => {
    const registry = new ProviderRegistry([gmailProvider]);

    expect(registry.has("gmail")).toBe(true);
    expect(registry.has("outlook")).toBe(false);
    expect(registry.list()).toEqual([gmailProvider]);
    expect(() => registry.get("outlook")).toThrow("Mail provider outlook is not registered");
  });

  test("Gmail delegates capability detection to the existing implementation", () => {
    expect(gmailProvider.detectCapabilities("https://www.googleapis.com/auth/gmail.readonly")).toEqual({
      read: true,
      draft: false,
      send: false,
    });
  });

  test("Outlook exposes read capabilities while sync remains an explicit stub", async () => {
    expect(outlookProvider.detectCapabilities(null)).toEqual({ read: false, draft: false, send: false });
    expect(outlookProvider.detectCapabilities("User.Read Mail.Read offline_access")).toEqual({ read: true, draft: false, send: false });
    await expect(outlookProvider.syncPage({} as never, { accountId: "account-1" }))
      .rejects.toEqual(new ProviderNotImplementedError("outlook", "sync"));
  });
});
