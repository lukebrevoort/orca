/** Production composer -> production API/SQLite -> injected provider transport.
 * This is component/API integration in Happy DOM, not browser/native E2E.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { MessageDraft } from "@orca/shared";
import { createDatabaseClient } from "../../api/src/db/client.ts";
import { users, oauthAccounts } from "../../api/src/db/schema.ts";
import { createSession } from "../../api/src/auth/session-store.ts";
import { createApp } from "../../api/src/index.ts";
import { ProviderRegistry } from "../../api/src/providers/registry.ts";
import { gmailProvider } from "../../api/src/providers/gmail/provider.ts";
import { GmailTransportError } from "../../api/src/providers/gmail/transport.ts";
import { ComposeWorkspace, useComposeDraft, type ComposeDraftController } from "./compose-workspace";

const names = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "getComputedStyle"] as const;
const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const originalFetch = globalThis.fetch;
const originalSecret = process.env.SESSION_SECRET;
const originalEncryption = process.env.TOKEN_ENCRYPTION_KEY;
let browser: InstanceType<typeof Window>;
let root: Root;
let controller: ComposeDraftController;
let directory: string;
let deliveries: Array<{ accountId: string; draft: MessageDraft }>;
let outcome: "sent" | "ambiguous";
let sentNotice: string;
let ready: boolean;
let cookie: string;
let app: ReturnType<typeof createApp>;
function Harness() {
  controller = useComposeDraft("second", "new", false);
  return <ComposeWorkspace controller={controller} contacts={[]} canSend={ready} onSent={result => { sentNotice = result.status; }} />;
}
function sendButton() { return [...browser.document.querySelectorAll("button")].find(button => button.textContent === "Send")!; }
async function render() { await act(async () => root.render(<Harness />)); }
async function writeDraft() {
  await act(async () => controller.updateDraft({ subject: "Integrated delivery", body: "First line\n\nSecond line", composeFormat: "plain" }));
  await act(async () => controller.setRecipientQueries!({ to: "Maya <maya@example.com>", cc: "cc@example.com", bcc: "bcc@example.com" }));
}
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  }
  expect(check(), browser.document.body.textContent ?? "Composer did not settle").toBe(true);
}
beforeEach(async () => {
  process.env.SESSION_SECRET = "compose-integration-fixture-secret-at-least-32-characters";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 29).toString("base64");
  directory = mkdtempSync(join(tmpdir(), "orca-compose-integration-"));
  const path = join(directory, "mail.sqlite");
  const { db, sqlite } = createDatabaseClient(path);
  migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../api/drizzle") });
  db.insert(users).values({ id: "owner", email: "owner@example.com" }).run();
  db.insert(oauthAccounts).values(["first", "second"].map((id, i) => ({ id, userId: "owner", provider: "gmail" as const, providerId: id, providerEmail: `${id}@example.com`, createdAt: new Date(i + 1) }))).run();
  cookie = `orca_session=${(await createSession(db, "owner")).token}`;
  sqlite.close();
  deliveries = []; outcome = "sent"; sentNotice = ""; ready = true;
  app = createApp({ dbFactory: () => createDatabaseClient(path), providerRegistry: new ProviderRegistry([{
    ...gmailProvider, detectCapabilities: () => ({ read: true, draft: true, send: true }),
    createTransport: () => ({
      async saveDraft(_db, _account, draft) { return { providerDraftId: `mirror-${draft.id}` }; },
      async deleteDraft() {},
      async send(_db, accountId, draft) {
        deliveries.push({ accountId, draft });
        if (outcome === "ambiguous") throw new GmailTransportError("Synthetic lost response", "ambiguous", false);
        return { providerMessageId: `sent-${draft.id}`, providerThreadId: `sent-thread-${draft.id}` };
      },
    }),
  }]) });
  browser = new Window({ url: "http://localhost" });
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? browser : name === "getComputedStyle" ? browser.getComputedStyle.bind(browser) : browser[name] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const container = browser.document.createElement("div"); browser.document.body.append(container);
  root = createRoot(container as unknown as Element);
  globalThis.fetch = (async (path: string, init?: RequestInit) => app.request(path, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), cookie } })) as typeof fetch;
  await render();
});
afterEach(async () => {
  await act(async () => root?.unmount()); browser?.close(); globalThis.fetch = originalFetch;
  for (const name of names) { const descriptor = originals.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name]; }
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  if (originalSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = originalSecret;
  if (originalEncryption === undefined) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY = originalEncryption;
  rmSync(directory, { recursive: true, force: true });
});
test("compose, autosave, pending recipients and send reach the chosen provider account once", async () => {
  await writeDraft();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 470)); });
  await act(async () => { sendButton().click(); sendButton().click(); });
  await waitFor(() => sentNotice === "sent");
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]!.accountId).toBe("second");
  expect(deliveries[0]!.draft).toMatchObject({ subject: "Integrated delivery", body: { text: "First line\n\nSecond line", html: null }, to: [{ name: "Maya", email: "maya@example.com" }], cc: [{ email: "cc@example.com" }], bcc: [{ email: "bcc@example.com" }] });
  expect(sentNotice).toBe("sent");
  expect(controller.draft.body).toBe("");
  const drafts = await (await app.request("/v1/drafts?accountId=second", { headers: { cookie } })).json();
  expect(drafts).toHaveLength(1); expect(drafts[0].deliveryStatus).toBe("sent");
  expect(await (await app.request("/v1/drafts?accountId=first", { headers: { cookie } })).json()).toEqual([]);
});
test("invalid visible recipient preserves the draft and makes no delivery call", async () => {
  await writeDraft();
  await act(async () => controller.setRecipientQueries!({ to: "maya@example.com", cc: "unfinished", bcc: "" }));
  await act(async () => sendButton().click());
  expect(deliveries).toHaveLength(0); expect(controller.draft.body).toContain("First line");
  expect(browser.document.body.textContent).toContain("Check the highlighted address");
});
test("uncertain provider outcome retains content and replay never calls provider twice", async () => {
  outcome = "ambiguous"; await writeDraft();
  await act(async () => sendButton().click()); await waitFor(() => browser.document.body.textContent?.includes("could not be confirmed") ?? false);
  expect(deliveries).toHaveLength(1); expect(sentNotice).toBe("");
  expect(controller.draft.body).toContain("First line");
  expect(browser.document.body.textContent).toContain("could not be confirmed");
  await act(async () => sendButton().click()); await waitFor(() => browser.document.body.textContent?.includes("could not be confirmed") ?? false);
  expect(deliveries).toHaveLength(1);
});
test("read-only account offers no send action while preserving editable writing", async () => {
  ready = false; await render(); await writeDraft();
  const enable = [...browser.document.querySelectorAll("button")].find(button => button.textContent === "Enable sending")!;
  expect(enable.disabled).toBe(true);
  await act(async () => enable.click());
  expect(deliveries).toHaveLength(0); expect(controller.draft.body).toContain("First line");
  expect(browser.document.querySelector('[aria-label="Message body"]')?.getAttribute("contenteditable")).toBe("true");
});
