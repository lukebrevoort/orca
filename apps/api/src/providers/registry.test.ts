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

  test("Gmail delegates capability detection to the existing implementation", () => {
    expect(gmailProvider.detectCapabilities("https://www.googleapis.com/auth/gmail.readonly")).toEqual({
      read: true,
      draft: false,
      send: false,
    });
  });

  test("Outlook exposes registered, explicit stubs", async () => {
    expect(outlookProvider.detectCapabilities(null)).toEqual({ read: false, draft: false, send: false });
    await expect(outlookProvider.syncPage({} as never, { accountId: "account-1" }))
      .rejects.toEqual(new ProviderNotImplementedError("outlook", "sync"));

    const response = await outlookProvider.createOAuthApp().request("/connect");
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({
      error: "outlook_oauth_not_implemented",
      message: "Outlook OAuth is not implemented",
    });
  });
});
