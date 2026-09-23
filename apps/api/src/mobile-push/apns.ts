import { connect, type ClientHttp2Session } from "node:http2";
import { importPKCS8, SignJWT } from "jose";

import type { MobilePushConfig } from "./config.ts";
import type { ApnsEnvironment } from "./store.ts";

export type ApnsDeliveryRequest = {
  token: string;
  environment: ApnsEnvironment;
  payload: Record<string, unknown>;
  apnsId: string;
  collapseId: string;
};

export type ApnsDeliveryResult =
  | { outcome: "success"; status: 200 }
  | { outcome: "retry"; status: number | null; reason: string; retryAfterMs?: number }
  | { outcome: "invalid_token"; status: number; reason: string; invalidatedAt: number | null }
  | { outcome: "permanent"; status: number; reason: string };

export interface ApnsTransport {
  send(request: ApnsDeliveryRequest): Promise<ApnsDeliveryResult>;
  close?(): void;
}

type ApnsErrorBody = { reason?: string; timestamp?: number };

export function classifyApnsResponse(status: number, body: ApnsErrorBody, retryAfter?: string): ApnsDeliveryResult {
  if (status === 200) return { outcome: "success", status: 200 };
  const reason = body.reason || `APNs returned HTTP ${status}`;
  if (status === 410 && reason === "Unregistered") {
    return { outcome: "invalid_token", status, reason, invalidatedAt: typeof body.timestamp === "number" ? body.timestamp : null };
  }
  if (status === 400 && (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic")) {
    return { outcome: "invalid_token", status, reason, invalidatedAt: null };
  }
  if (status === 429 || status === 500 || status === 503 || reason === "ExpiredProviderToken") {
    const retryAfterMs = parseRetryAfter(retryAfter);
    return { outcome: "retry", status, reason, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  }
  return { outcome: "permanent", status, reason };
}

function parseRetryAfter(value?: string) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/** HTTP/2 token-authenticated APNs transport with a reusable connection per environment. */
export function createApnsTransport(config: MobilePushConfig, options: { now?: () => Date } = {}): ApnsTransport {
  if (!config.configured || !config.teamId || !config.keyId || !config.privateKey || !config.bundleId) {
    return { async send() { return { outcome: "retry", status: null, reason: config.disabledReason ?? "APNs is not configured" }; } };
  }
  const now = options.now ?? (() => new Date());
  const sessions = new Map<ApnsEnvironment, ClientHttp2Session>();
  let signingKey: ReturnType<typeof importPKCS8> | null = null;
  let cachedJwt: { value: string; createdAt: number } | null = null;

  async function authorization() {
    const timestamp = now().getTime();
    // Apple permits 20–60 minute rotation; refresh at 50 minutes.
    if (cachedJwt && timestamp - cachedJwt.createdAt < 50 * 60_000) return cachedJwt.value;
    signingKey ??= importPKCS8(config.privateKey!, "ES256");
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: config.keyId! })
      .setIssuer(config.teamId!)
      .setIssuedAt(Math.floor(timestamp / 1000))
      .sign(await signingKey);
    cachedJwt = { value, createdAt: timestamp };
    return value;
  }

  function session(environment: ApnsEnvironment) {
    const existing = sessions.get(environment);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const host = environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
    const created = connect(host);
    created.unref?.();
    created.on("error", () => sessions.delete(environment));
    created.on("close", () => sessions.delete(environment));
    sessions.set(environment, created);
    return created;
  }

  return {
    async send(input) {
      const payload = JSON.stringify(input.payload);
      const jwt = await authorization();
      try {
        return await new Promise<ApnsDeliveryResult>((resolve) => {
          const stream = session(input.environment).request({
            ":method": "POST",
            ":path": `/3/device/${input.token}`,
            authorization: `bearer ${jwt}`,
            "apns-topic": config.bundleId!,
            "apns-push-type": "alert",
            "apns-priority": "10",
            "apns-id": input.apnsId,
            "apns-collapse-id": input.collapseId,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
          });
          let status = 0;
          let retryAfter: string | undefined;
          const chunks: Buffer[] = [];
          let settled = false;
          const finish = (result: ApnsDeliveryResult) => {
            if (settled) return;
            settled = true;
            resolve(result);
          };
          stream.setTimeout(15_000, () => {
            stream.close();
            finish({ outcome: "retry", status: null, reason: "APNs request timed out" });
          });
          stream.on("response", (headers) => {
            status = Number(headers[":status"] ?? 0);
            const header = headers["retry-after"];
            retryAfter = Array.isArray(header) ? header[0] : header?.toString();
          });
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("error", (error) => finish({ outcome: "retry", status: null, reason: error.message }));
          stream.on("end", () => {
            let body: ApnsErrorBody = {};
            try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ApnsErrorBody; } catch { /* APNs success has no body. */ }
            if (body.reason === "ExpiredProviderToken") cachedJwt = null;
            finish(classifyApnsResponse(status, body, retryAfter));
          });
          stream.end(payload);
        });
      } catch (error) {
        return { outcome: "retry", status: null, reason: error instanceof Error ? error.message : "APNs transport failure" };
      }
    },
    close() {
      for (const connection of sessions.values()) connection.close();
      sessions.clear();
    },
  };
}
