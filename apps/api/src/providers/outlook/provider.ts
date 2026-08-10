import { Hono } from "hono";

import type { AuthVariables } from "../../auth/middleware.ts";
import type { MailProviderAdapter, ProviderTransport } from "../shared/interfaces.ts";
import { ProviderNotImplementedError } from "../shared/interfaces.ts";

const unavailableTransport: ProviderTransport = {
  async saveDraft() { throw new ProviderNotImplementedError("outlook", "transport"); },
  async deleteDraft() { throw new ProviderNotImplementedError("outlook", "transport"); },
  async send() { throw new ProviderNotImplementedError("outlook", "transport"); },
};

export const outlookProvider: MailProviderAdapter = {
  provider: "outlook",
  createOAuthApp() {
    const app = new Hono<{ Variables: AuthVariables }>();
    app.all("/*", (c) => c.json({
      error: "outlook_oauth_not_implemented",
      message: "Outlook OAuth is not implemented",
    }, 501));
    return app;
  },
  detectCapabilities() {
    return { read: false, draft: false, send: false };
  },
  async syncPage() {
    throw new ProviderNotImplementedError("outlook", "sync");
  },
  createTransport() {
    return unavailableTransport;
  },
};
