import type { MailProvider } from "@orca/shared";

import { gmailProvider } from "./gmail/provider.ts";
import { outlookProvider } from "./outlook/provider.ts";
import type { MailProviderAdapter } from "./shared/interfaces.ts";

export class ProviderRegistry {
  readonly #providers = new Map<MailProvider, MailProviderAdapter>();

  constructor(providers: Iterable<MailProviderAdapter>) {
    for (const provider of providers) {
      if (this.#providers.has(provider.provider)) {
        throw new Error(`Mail provider ${provider.provider} is already registered`);
      }
      this.#providers.set(provider.provider, provider);
    }
  }

  get(provider: MailProvider): MailProviderAdapter {
    const adapter = this.#providers.get(provider);
    if (!adapter) throw new Error(`Mail provider ${provider} is not registered`);
    return adapter;
  }

  has(provider: MailProvider): boolean {
    return this.#providers.has(provider);
  }

  list(): MailProviderAdapter[] {
    return [...this.#providers.values()];
  }
}

export const providerRegistry = new ProviderRegistry([gmailProvider, outlookProvider]);
