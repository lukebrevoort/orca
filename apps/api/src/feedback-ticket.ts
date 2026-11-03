import { createHash } from "node:crypto";
import type { Hono, MiddlewareHandler } from "hono";
import { feedbackTicketSubmissionSchema, type FeedbackTicketSubmission, type FeedbackTicketReceipt, type FeedbackTicketAttachment } from "@orca/shared";
import type { FeedbackReport } from "@feedback-kit/core";
import { requireAuth, type AuthVariables } from "./auth/middleware.ts";
import { createDatabaseClient } from "./db/client.ts";
import { readBoundedRequestBody } from "./request-body.ts";
import { createLinearFeedbackSubmitter } from "./integrations/linear.ts";

export type FeedbackTicketDelivery = (report: FeedbackReport, options: { issueId: string }) => Promise<FeedbackTicketReceipt>;

// Linear is the durable record. Exact retries derive the same opaque UUID even
// after a process restart or session-key rotation. Including normalized content
// prevents changed feedback from acknowledging an earlier, different report.
// The client request UUID supplies random entropy; set v4/variant bits to match
// Linear IssueCreateInput.id, which documents a UUIDv4.
export function feedbackTicketId(userId: string, input: FeedbackTicketSubmission): string {
  const identity: unknown[] = ["orca-feedback-ticket-v1", userId, input.id, input.message, input.platform];
  // Empty/omitted attachments retain the existing text-only ticket identity.
  if (input.attachments?.length) identity.push(input.attachments.map(file => [file.id, file.name, file.mimeType, file.size, createHash("sha256").update(file.dataUrl).digest("hex")]));
  const bytes = createHash("sha256").update(JSON.stringify(identity)).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
// Bounded, canonical base64 and container signatures, not a media decoder.
// Reject malformed or disguised active content before any provider call.
export function validFeedbackAttachment(file: FeedbackTicketAttachment): boolean {
  const prefix = `data:${file.mimeType};base64,`;
  if (!file.dataUrl.startsWith(prefix)) return false;
  const encoded = file.dataUrl.slice(prefix.length);
  if (encoded.length !== 4 * Math.ceil(file.size / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return false;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== file.size || bytes.toString("base64") !== encoded) return false;
  const starts = (values: number[]) => values.every((value, index) => bytes[index] === value);
  switch (file.mimeType) {
    case "image/png": return starts([137, 80, 78, 71, 13, 10, 26, 10]);
    case "image/jpeg": return starts([255, 216, 255]);
    case "image/webp": return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
    case "video/webm": return starts([26, 69, 223, 163]) && bytes.subarray(0, 4096).includes(Buffer.from("webm"));
    case "video/mp4":
    case "video/quicktime": {
      if (bytes.length < 16 || bytes.toString("ascii", 4, 8) !== "ftyp") return false;
      const size = bytes.readUInt32BE(0);
      if (size < 16 || size > Math.min(bytes.length, 4096) || (size - 16) % 4 !== 0) return false;
      const brands = [bytes.toString("ascii", 8, 12)];
      // ftyp lists a major brand, minor version, then compatible brands. A
      // reader can recognize any advertised compatible specification (MP4RA:
      // https://mp4ra.org/registered-types/brands). Never scan past this box.
      for (let offset = 16; offset < size; offset += 4) brands.push(bytes.toString("ascii", offset, offset + 4));
      if (file.mimeType === "video/quicktime") return brands.includes("qt  ");
      const mp4Brands = ["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "iso7", "iso8", "iso9", "isoa", "isob", "isoc", "mp41", "mp42", "mp71", "avc1", "av01", "M4V ", "MSNV", "dash"];
      return brands.some(brand => mp4Brands.includes(brand));
    }
  }
}
function report(input: FeedbackTicketSubmission, issueId: string): FeedbackReport {
  return { schemaVersion: 1, id: issueId, project: { id: "orca", name: "Orca" },
    kind: "other", severity: "normal", title: input.message.split(/\r?\n/, 1)[0]!.slice(0, 100), description: input.message,
    context: { route: "/feedback", url: "/feedback", title: "Orca", userAgent: input.platform,
      viewport: { width: 0, height: 0, pixelRatio: 1 }, locale: "", timezone: "", capturedAt: new Date().toISOString() },
    elements: [], attachments: (input.attachments ?? []).map(file => ({ id: file.id, name: file.name, mimeType: file.mimeType, dataUrl: file.dataUrl, source: "upload" as const })), metadata: { platform: input.platform } };
}
function validReceipt(receipt: FeedbackTicketReceipt): boolean {
  try {
    const url = new URL(receipt.url);
    return typeof receipt.identifier === "string" && receipt.identifier.length > 0 && receipt.identifier.length <= 100
      && url.protocol === "https:" && url.hostname === "linear.app" && !url.username && !url.password;
  } catch { return false; }
}

export function registerFeedbackTicketRoutes(app: Hono<{ Variables: AuthVariables }>, options: {
  dbFactory?: typeof createDatabaseClient;
  allowedOrigin: string;
  deliver?: FeedbackTicketDelivery | null;
  ownerUserId?: string;
}) {
  const dbFactory = options.dbFactory ?? createDatabaseClient;
  const deliver = options.deliver === undefined ? createLinearFeedbackSubmitter() : options.deliver;
  // One configured personal workspace is not a per-user Linear integration.
  // Require an explicit Orca identity; never use the first user or Linear ID.
  const ownerUserId = (options.ownerUserId ?? process.env.LINEAR_FEEDBACK_OWNER_USER_ID)?.trim();
  const path = "/v1/feedback/ticket";
  let activeRequests = 0;
  const inFlight = new Map<string, Promise<FeedbackTicketReceipt>>();
  app.use(path, requireAuth({ dbFactory }));
  const originGuard: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.req.method === "POST") {
      const origin = c.req.header("origin");
      if (origin ? origin !== options.allowedOrigin : !c.req.header("authorization")) {
        return c.json({ error: { code: "invalid_origin", message: "Feedback must come from Orca." } }, 403);
      }
    }
    await next();
  };
  app.use(path, originGuard);
  app.get(path, (c) => c.json({ available: Boolean(ownerUserId && ownerUserId === c.get("auth").userId && deliver) }));
  app.post(path, async (c) => {
    const userId = c.get("auth").userId;
    if (!ownerUserId || ownerUserId !== userId) return c.json({ error: { code: "feedback_unavailable", message: "Linear feedback is not connected for this account." } }, 403);
    if (!deliver) return c.json({ error: { code: "feedback_unavailable", message: "Linear feedback is not connected yet. Your message has not been sent." } }, 503);
    if (activeRequests >= 4) return c.json({ error: { code: "feedback_busy", message: "Feedback is busy. Please retry in a moment." } }, 429);
    activeRequests++;
    try {
      const bytes = await readBoundedRequestBody(c.req.raw, 28 * 1024 * 1024);
      if (!bytes) return c.json({ error: { code: "payload_too_large", message: "Feedback is too large." } }, 413);
      let body: unknown;
      try { body = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { return c.json({ error: { code: "invalid_feedback", message: "Feedback must be valid JSON." } }, 400); }
      const parsed = feedbackTicketSubmissionSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: { code: "invalid_feedback", message: "Check your message and attachments: up to 3 files, 10 MiB each and 20 MiB total." } }, 400);
      if (!(parsed.data.attachments ?? []).every(validFeedbackAttachment)) {
        return c.json({ error: { code: "invalid_attachment", message: "An attachment does not match its file type or size. Choose a PNG, JPEG, WebP, MP4, WebM or MOV file." } }, 400);
      }
      const issueId = feedbackTicketId(userId, parsed.data);
      let pending = inFlight.get(issueId);
      if (!pending) {
        if (inFlight.size >= 4) return c.json({ error: { code: "feedback_busy", message: "Feedback is busy. Please retry in a moment." } }, 429);
        pending = Promise.resolve().then(() => deliver(report(parsed.data, issueId), { issueId }));
        inFlight.set(issueId, pending);
      }
      try {
        const receipt = await pending;
        if (!validReceipt(receipt)) throw new Error("Invalid Linear receipt");
        return c.json({ identifier: receipt.identifier, url: receipt.url }, 201);
      } catch {
        // A timeout may follow a successful create. Keep the same request payload
        // on retry so Linear can confirm the existing issue without duplication.
        return c.json({ error: { code: "feedback_delivery_failed", message: "Could not confirm your Linear ticket. Keep this message and retry." } }, 502);
      } finally {
        if (inFlight.get(issueId) === pending) inFlight.delete(issueId);
      }
    } finally { activeRequests--; }
  });
}
