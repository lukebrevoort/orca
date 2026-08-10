import { detectOutlookCapabilities } from "../../auth/outlook/capabilities.ts";
import { createOutlookAuthApp } from "../../auth/outlook/routes.ts";
import type { MailProviderAdapter, ProviderTransport } from "../shared/interfaces.ts";
import { ProviderNotImplementedError } from "../shared/interfaces.ts";

const unavailableTransport: ProviderTransport = {
  async saveDraft() { throw new ProviderNotImplementedError("outlook", "transport"); },
  async deleteDraft() { throw new ProviderNotImplementedError("outlook", "transport"); },
  async send() { throw new ProviderNotImplementedError("outlook", "transport"); },
};

export const outlookProvider: MailProviderAdapter = {
  provider: "outlook",
  createOAuthApp: createOutlookAuthApp,
  detectCapabilities: detectOutlookCapabilities,
  async syncPage() {
    throw new ProviderNotImplementedError("outlook", "sync");
  },
  createTransport() {
    return unavailableTransport;
  },
};
