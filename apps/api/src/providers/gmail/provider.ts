import { detectGmailCapabilities } from "../../auth/gmail/capabilities.ts";
import { createGmailAuthApp } from "../../auth/gmail/routes.ts";
import type { MailProviderAdapter } from "../shared/interfaces.ts";
import { syncGmailAccountPage } from "./sync.ts";
import { createGmailTransport } from "./transport.ts";

export const gmailProvider: MailProviderAdapter = {
  provider: "gmail",
  createOAuthApp: createGmailAuthApp,
  detectCapabilities: detectGmailCapabilities,
  syncPage: syncGmailAccountPage,
  createTransport: createGmailTransport,
};
