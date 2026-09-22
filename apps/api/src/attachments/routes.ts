import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { requireAuth, type AuthVariables } from "../auth/middleware.ts";
import { createDatabaseClient } from "../db/client.ts";
import { emailAttachments, emails, oauthAccounts } from "../db/schema.ts";
import { getGmailProviderTokens } from "../providers/gmail/sync.ts";

const maximumAttachmentBytes = 25 * 1024 * 1024;
const maximumResponseBytes = 36 * 1024 * 1024;
type Options = {
  dbFactory?: typeof createDatabaseClient;
  fetch?: typeof fetch;
  getTokens?: typeof getGmailProviderTokens;
};

/** Download only attachments joined to an account owned by the authenticated user. */
export function registerAttachmentRoutes(app: Hono<{ Variables: AuthVariables }>, options: Options = {}) {
  const dbFactory = options.dbFactory ?? createDatabaseClient;
  const fetchImpl = options.fetch ?? fetch;
  const getTokens = options.getTokens ?? getGmailProviderTokens;
  app.get("/v1/attachments/:id", requireAuth({ dbFactory }), async (c) => {
    c.header("Cache-Control", "private, no-store");
    c.header("X-Content-Type-Options", "nosniff");
    const accountId = c.req.query("accountId");
    if (!accountId) return c.json({ error: { code: "validation_error", message: "An accountId is required" } }, 400);
    const { db, sqlite } = dbFactory();
    try {
      const record = db.select({
        attachment: emailAttachments,
        providerMessageId: emails.providerMessageId,
        provider: oauthAccounts.provider,
      }).from(emailAttachments)
        .innerJoin(emails, eq(emails.id, emailAttachments.emailId))
        .innerJoin(oauthAccounts, eq(oauthAccounts.id, emails.accountId))
        .where(and(eq(emailAttachments.id, c.req.param("id")), eq(oauthAccounts.id, accountId), eq(oauthAccounts.userId, c.get("auth").userId))).get();
      if (!record) return c.json({ error: { code: "not_found", message: "Attachment not found" } }, 404);
      if (record.provider !== "gmail") return c.json({ error: { code: "missing_capability", message: "Attachment download is not available for this provider" } }, 501);
      if (record.attachment.size > maximumAttachmentBytes) return c.json({ error: { code: "attachment_limit", message: "This attachment exceeds the 25 MB download limit" } }, 413);
      let tokens = await getTokens(db, accountId);
      if (!tokens?.accessToken) return c.json({ error: { code: "provider_auth_error", message: "Reconnect Gmail to download attachments" } }, 409);
      const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(record.providerMessageId)}/attachments/${encodeURIComponent(record.attachment.providerAttachmentId)}`;
      const download = (token: string) => fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
      let response = await download(tokens.accessToken);
      if (response.status === 401) {
        await response.body?.cancel();
        tokens = await getTokens(db, accountId, { forceRefresh: true });
        if (!tokens?.accessToken) return c.json({ error: { code: "provider_auth_error", message: "Reconnect Gmail to download attachments" } }, 409);
        response = await download(tokens.accessToken);
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404) return c.json({ error: { code: "not_found", message: "The attachment is no longer available" } }, 404);
        return c.json({ error: { code: "provider_error", message: "The attachment could not be downloaded. Try again." } }, 502);
      }
      const payload = JSON.parse(await readBoundedResponse(response)) as { data?: unknown; size?: unknown };
      if (typeof payload.data !== "string" || !/^[A-Za-z0-9_-]*={0,2}$/.test(payload.data)) throw new Error("Invalid attachment data");
      const bytes = Buffer.from(payload.data, "base64url");
      if (bytes.length > maximumAttachmentBytes) return c.json({ error: { code: "attachment_limit", message: "This attachment exceeds the 25 MB download limit" } }, 413);
      if (typeof payload.size !== "number" || payload.size !== bytes.length) throw new Error("Incomplete attachment data");
      const filename = record.attachment.filename.replace(/[\u0000-\u001f\u007f/\\]/g, "_").slice(0, 255) || "attachment";
      const asciiName = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
      const encodedName = encodeURIComponent(filename).replace(/['()*]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
      c.header("Content-Type", "application/octet-stream");
      c.header("Content-Disposition", `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`);
      c.header("Content-Length", String(bytes.length));
      return c.body(new Uint8Array(bytes));
    } catch {
      return c.json({ error: { code: "provider_error", message: "The attachment could not be downloaded. Try again." } }, 502);
    } finally { sqlite.close(); }
  });
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (Number(response.headers.get("content-length")) > maximumResponseBytes) {
    await response.body?.cancel();
    throw new Error("Attachment response exceeds limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing attachment body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumResponseBytes) {
        await reader.cancel();
        throw new Error("Attachment response exceeds limit");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, length).toString("utf8");
  } finally { reader.releaseLock(); }
}
