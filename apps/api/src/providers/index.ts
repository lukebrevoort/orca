export { gmailProvider } from "./gmail/provider.ts";
export { outlookProvider } from "./outlook/provider.ts";
export { ProviderRegistry, providerRegistry } from "./registry.ts";
export type {
  MailProviderAdapter,
  ProviderDatabase,
  ProviderDraftResult,
  ProviderSyncOptions,
  ProviderSyncResult,
  ProviderTransport,
  ProviderTransportResult,
} from "./shared/interfaces.ts";
export { ProviderNotImplementedError } from "./shared/interfaces.ts";
