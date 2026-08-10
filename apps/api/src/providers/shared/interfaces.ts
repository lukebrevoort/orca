import type { MailCapabilities, MailProvider, MessageDraft } from "@orca/shared";
import type { Hono } from "hono";

import type { AuthVariables } from "../../auth/middleware.ts";
import type { createDatabaseClient } from "../../db/client.ts";

export type ProviderDatabase = ReturnType<typeof createDatabaseClient>["db"];

export type ProviderSyncOptions = {
  accountId: string;
  cursor?: string | null;
  pageSize?: number;
};

export type ProviderSyncResult = {
  nextCursor: string | null;
  emailCount: number;
  threadCount: number;
  labelCount: number;
  contactCount: number;
};

export type ProviderTransportResult = {
  providerMessageId: string;
  providerThreadId: string;
};

export interface ProviderTransport {
  saveDraft(db: ProviderDatabase, accountId: string, draft: MessageDraft): Promise<{ providerDraftId: string }>;
  deleteDraft(db: ProviderDatabase, accountId: string, providerDraftId: string): Promise<void>;
  send(db: ProviderDatabase, accountId: string, draft: MessageDraft): Promise<ProviderTransportResult>;
}

export interface MailProviderAdapter {
  readonly provider: MailProvider;
  createOAuthApp(options?: { dbFactory?: typeof createDatabaseClient }): Hono<{ Variables: AuthVariables }>;
  detectCapabilities(scopes: string | string[] | null): MailCapabilities;
  syncPage(db: ProviderDatabase, options: ProviderSyncOptions): Promise<ProviderSyncResult>;
  createTransport(): ProviderTransport;
}

export class ProviderNotImplementedError extends Error {
  constructor(readonly provider: MailProvider, readonly operation: "oauth" | "sync" | "transport") {
    super(`${provider} ${operation} is not implemented`);
    this.name = "ProviderNotImplementedError";
  }
}
