import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type OAuthAccountRecord = {
  id: string;
  provider: "gmail";
  providerAccountId: string;
  providerEmail: string;
  grantedScopes: string[];
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  tokenType: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OAuthAccountUpsert = Omit<OAuthAccountRecord, "id" | "createdAt" | "updatedAt">;

export interface OAuthAccountStore {
  upsert(input: OAuthAccountUpsert): Promise<OAuthAccountRecord>;
}

export class InMemoryOAuthAccountStore implements OAuthAccountStore {
  private readonly records = new Map<string, OAuthAccountRecord>();

  async upsert(input: OAuthAccountUpsert): Promise<OAuthAccountRecord> {
    const now = new Date().toISOString();
    const key = buildKey(input.provider, input.providerAccountId);
    const existing = this.records.get(key);
    const record: OAuthAccountRecord = {
      ...input,
      id: existing?.id ?? `oauth_${input.provider}_${input.providerAccountId}`,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.records.set(key, record);
    return record;
  }

  getAll(): OAuthAccountRecord[] {
    return [...this.records.values()];
  }
}

export class FileOAuthAccountStore implements OAuthAccountStore {
  constructor(private readonly filePath: string) {}

  async upsert(input: OAuthAccountUpsert): Promise<OAuthAccountRecord> {
    const existing = await this.readAll();
    const now = new Date().toISOString();
    const index = existing.findIndex(
      (record) =>
        record.provider === input.provider &&
        record.providerAccountId === input.providerAccountId,
    );
    const previous = index >= 0 ? existing[index] : null;
    const next: OAuthAccountRecord = {
      ...input,
      id: previous?.id ?? `oauth_${input.provider}_${input.providerAccountId}`,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };

    if (index >= 0) {
      existing[index] = next;
    } else {
      existing.push(next);
    }

    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(existing, null, 2).concat("\n"), "utf8");
    return next;
  }

  private async readAll(): Promise<OAuthAccountRecord[]> {
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as OAuthAccountRecord[];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }
  }
}

function buildKey(provider: string, providerAccountId: string): string {
  return `${provider}:${providerAccountId}`;
}

function isMissingFileError(error: unknown): error is Error & { code?: string } {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
