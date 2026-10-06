import { afterEach, beforeEach, expect, test } from "bun:test";
import { expectedSearchHeaders, resolveSearchCapabilities, searchResponseMatchesMode } from "./search-capabilities";
const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
beforeEach(() => Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://orca.example.test" } } }));
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else delete (globalThis as Record<string, unknown>).window;
});
function capability(mode: "legacy-metadata" | "indexed", ownerId: string, epoch = "a".repeat(64)) {
  return { version: 1, mode, epoch, ownerId, coverage: mode === "indexed" ? "stored-plaintext" : "stored-metadata", semantics: mode === "indexed" ? "literal-index-v3" : "legacy-substring-v1" };
}
function session(ownerId: string) { return { isAuthenticated: true, user: { id: ownerId, email: "owner@example.test", name: "Owner" }, expiresAt: "2026-12-01T00:00:00.000Z", onboardingCompletedAt: null }; }

test("an authenticated initial old-server404 selects explicit metadata compatibility", async () => {
  globalThis.fetch = (async (input: string | URL | Request) => String(input).endsWith("capabilities") ? new Response(null, { status: 404 }) : Response.json(session("legacy-first-owner"))) as unknown as typeof fetch;
  const selected = await resolveSearchCapabilities();
  expect(selected.mode).toBe("legacy-metadata"); expect(selected.verified).toBe(false);
  expect(selected.coverage).toBe("stored-metadata");
  expect(expectedSearchHeaders(selected)?.["X-Orca-Expected-Search-Epoch"]).toBe("legacy-server");
  expect(searchResponseMatchesMode(new Response(), selected)).toBe(true);
});

test("after indexed capability only an explicit authenticated disabled mode allows rollback", async () => {
  globalThis.fetch = (async () => Response.json(capability("indexed", "activated-owner"))) as unknown as typeof fetch;
  const indexed = await resolveSearchCapabilities(); expect(indexed.mode).toBe("indexed");
  globalThis.fetch = (async (input: string | URL | Request) => String(input).endsWith("capabilities") ? new Response(null, { status: 404 }) : Response.json(session("activated-owner"))) as unknown as typeof fetch;
  expect(resolveSearchCapabilities()).rejects.toThrow("cannot confirm");
  globalThis.fetch = (async () => Response.json(capability("legacy-metadata", "activated-owner", "b".repeat(64)))) as unknown as typeof fetch;
  const rollback = await resolveSearchCapabilities();
  expect(rollback.mode).toBe("legacy-metadata"); expect(rollback.epoch).not.toBe(indexed.epoch);
  expect(rollback.verified).toBe(true);
});

test("capability transport/auth/schema failures never select legacy", async () => {
  for (const status of [401, 403, 503]) {
    globalThis.fetch = (async () => new Response(null, { status })) as unknown as typeof fetch;
    await expect(resolveSearchCapabilities()).rejects.toThrow("could not be checked");
  }
  globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  await expect(resolveSearchCapabilities()).rejects.toThrow("offline");
  globalThis.fetch = (async () => Response.json({ ...capability("indexed", "invalid-owner"), coverage: "stored-metadata" })) as unknown as typeof fetch;
  await expect(resolveSearchCapabilities()).rejects.toThrow("unsupported search mode");
});

test("supporting response headers bind the exact selected mode and epoch", async () => {
  globalThis.fetch = (async () => Response.json(capability("indexed", "header-owner"))) as unknown as typeof fetch;
  const selected = await resolveSearchCapabilities();
  expect(searchResponseMatchesMode(new Response(), selected)).toBe(false);
  expect(searchResponseMatchesMode(new Response(null, { headers: { "X-Orca-Search-Mode": "indexed", "X-Orca-Search-Epoch": selected.epoch } }), selected)).toBe(true);
  expect(searchResponseMatchesMode(new Response(null, { headers: { "X-Orca-Search-Mode": "legacy-metadata", "X-Orca-Search-Epoch": selected.epoch } }), selected)).toBe(false);
  expect(searchResponseMatchesMode(new Response(null, { headers: { "X-Orca-Search-Mode": "indexed", "X-Orca-Search-Epoch": "b".repeat(64) } }), selected)).toBe(false);
});
