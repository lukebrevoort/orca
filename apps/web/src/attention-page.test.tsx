import { refreshDestinations } from "./mail-destinations";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabaseClient } from "../../api/src/db/client";
import {
  emails,
  oauthAccounts,
  senderAttentionRules,
  threads,
  users,
} from "../../api/src/db/schema";
import { createSession } from "../../api/src/auth/session-store";
import { createApp } from "../../api/src/index";
import { InboxApp, defaultReaderPreferences } from "./App";
import { TopLayerProvider } from "./top-layer";
import { AttentionPage } from "./attention-page";
import { AttentionRoutingProvider } from "./attention-routing";
import { RoutingChooser } from "./routing-chooser";
import { destinationRoutingStateSchema } from "@orca/shared";
const globals = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLButtonElement",
  "MutationObserver",
  "CustomEvent",
  "Text",
  "DocumentFragment",
  "getComputedStyle",
  "cancelAnimationFrame",
  "HTMLInputElement",
  "HTMLSelectElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "requestAnimationFrame",
] as const;
const originals = new Map(
  globals.map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]),
);
const originalFetch = globalThis.fetch;
const env = {
  SESSION_SECRET: process.env.SESSION_SECRET,
  TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY,
};
let browser: Window, root: Root, container: HTMLElement, directory: string;
let app: ReturnType<typeof createApp>, cookie: string;
let intercept:
  | ((path: string, init?: RequestInit) => Promise<Response | undefined>)
  | undefined;
let puts: Array<{ path: string; body: any }>;
let refreshes: number;
let quietId: string, fallbackId: string;
let onRefresh: (() => Promise<void>) | undefined;
beforeEach(async () => {
  process.env.SESSION_SECRET = "attention-web-integration-test-session-secret";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");
  directory = mkdtempSync(join(tmpdir(), "attention-web-"));
  const path = join(directory, "test.sqlite");
  const client = createDatabaseClient(path);
  migrate(client.db, {
    migrationsFolder: resolve(import.meta.dir, "../../api/drizzle"),
  });
  client.db
    .insert(users)
    .values({ id: "owner", email: "owner@example.com" })
    .run();
  client.db
    .insert(oauthAccounts)
    .values(
      ["a", "b"].map((id) => ({
        id,
        userId: "owner",
        provider: "gmail" as const,
        providerId: id,
        providerEmail: `${id}@example.com`,
      })),
    )
    .run();
  client.db
    .insert(threads)
    .values(
      ["a", "b"].map((id) => ({
        id: `thread-${id}`,
        accountId: id,
        providerThreadId: id,
        messageCount: 1,
      })),
    )
    .run();
  client.db
    .insert(emails)
    .values(
      ["a", "b"].map((id) => ({
        id: `message-${id}`,
        threadId: `thread-${id}`,
        accountId: id,
        providerMessageId: id,
        fromAddress: "maya@example.com",
        fromName: "Maya Chen",
        subject: `Mail ${id}`,
        receivedAt: new Date(),
        bodyText: "Hello",
      })),
    )
    .run();
  client.db
    .insert(senderAttentionRules)
    .values({
      id: "maya",
      accountId: "a",
      scope: "address",
      value: "maya@example.com",
      behavior: "normal",
      source: "user_choice",
    })
    .run();
  cookie = `orca_session=${(await createSession(client.db, "owner")).token}`;
  client.sqlite.close();
  app = createApp({ dbFactory: () => createDatabaseClient(path) });
  browser = new Window({ url: "http://localhost/" });
  for (const name of globals)
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value:
        name === "requestAnimationFrame"
          ? (callback: FrameRequestCallback) => setTimeout(callback, 0)
          : browser[name as keyof Window],
    });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  // happy-dom implements dialog attributes but not the browser's modal methods.
  browser.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  browser.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  puts = [];
  refreshes = 0;
  onRefresh = undefined;
  intercept = undefined;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const path = String(input);
    if (init?.method === "PUT")
      puts.push({ path, body: JSON.parse(String(init.body)) });
    return (await intercept?.(path, init)) ?? (await request(path, init));
  }) as typeof fetch;
  const catalog = await (await request("/v1/destinations")).json();
  fallbackId = catalog.fallbackDestinationId;
  const created = await (await request("/v1/destinations", { method: "POST", body: JSON.stringify({ expectedRevision: catalog.revision, name: "Quiet" }) })).json();
  quietId = created.destinationId;
  await refreshDestinations();
});
afterEach(async () => {
  await act(async () => root.unmount());
  globalThis.fetch = originalFetch;
  for (const name of globals) {
    const old = originals.get(name);
    if (old) Object.defineProperty(globalThis, name, old);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  await browser.happyDOM.close();
  rmSync(directory, { recursive: true, force: true });
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
function request(path: string, init?: RequestInit) {
  return app.request(path, {
    ...init,
    headers: { cookie, "content-type": "application/json" },
  });
}
async function state(account = "a", query = "") {
  let result!: ReturnType<typeof destinationRoutingStateSchema.parse>;
  await act(async () => {
    result = destinationRoutingStateSchema.parse(
      await (
        await request(`/v1/destinations/routing?accountId=${account}${query}`)
      ).json(),
    );
  });
  return result;
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
async function render(chooser = false) {
  await act(async () =>
    root.render(
      <AttentionRoutingProvider
        onRefresh={async () => {
          refreshes++;
          await onRefresh?.();
        }}
      >
        <button aria-current="page">Attention navigation</button>
        {chooser ? (
          <RoutingChooser
            message={{
              id: "message-a",
              accountId: "a",
              threadId: "thread-a",
              from: { email: "maya@example.com", name: "Maya Chen" },
            }}
          />
        ) : (
          <AttentionPage onAdvanced={() => {}} />
        )}
      </AttentionRoutingProvider>,
    ),
  );
  await settle();
  await settle();
}
function button(text: string) {
  const found = Array.from(document.querySelectorAll("button")).find((b) =>
    text === "Tune"
      ? b.classList.contains("sender-attention-trigger")
      : b.textContent === text,
  );
  expect(found, `Missing button ${text}. Page: ${document.body.textContent}`).toBeDefined();
  return found!;
}
async function click(text: string) {
  await act(async () => button(text).click());
  await settle();
}
async function editableSelect(label: string) {
  // App navigation loads accounts before it can load their routing choices.
  // A fixed settle delay can end between those reads in a busy full-suite run.
  const selector = `[aria-label="${label}"]`;
  const deadline = Date.now() + 2000;
  let control = document.querySelector<HTMLSelectElement>(selector);
  while ((!control || control.disabled) && Date.now() < deadline) {
    await settle();
    control = document.querySelector<HTMLSelectElement>(selector);
  }
  expect(control, `Expected ${label} to load. Page: ${document.body.textContent}`).not.toBeNull();
  expect(control!.disabled, `Expected ${label} to become editable`).toBe(false);
  return control!;
}
async function select(label: string, value: string) {
  const control = await editableSelect(label);
  await act(async () => {
    control.value = value;
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}
async function expectEmptySenderRules(accountId: string) {
  await editableSelect("Default destination for everyone else");
  expect((await editableSelect("Attention account")).value).toBe(accountId);
  // Both accounts know Maya from mail; hidden Add-sender suggestions may include
  // her, but another account's explicit rules must never appear in this list.
  const senderList = document.querySelector('[aria-labelledby="sender-heading"]');
  expect(senderList).not.toBeNull();
  expect(senderList!.querySelectorAll(".simple-attention-row")).toHaveLength(0);
  expect(senderList!.querySelector(".simple-attention-empty")?.textContent).toContain("Add a sender to choose where their mail goes.");
}

test("page saves actual sender routing, refreshes consumers, Undo restores prior explicit state, accounts isolated", async () => {
  await render();
  await select("Destination for maya@example.com", quietId);
  expect((await state()).senders[0]?.destinationId).toBe(quietId);
  expect((await state("b")).senders).toHaveLength(0);
  expect(puts[0]?.body).toMatchObject({
    target: { scope: "sender", address: "maya@example.com" },
    expectedRevision: expect.any(Number),
  });
  expect(refreshes).toBe(1);
  await click("Undo");
  expect((await state()).senders[0]?.destinationId).toBe(fallbackId);
  await select("Attention account", "b");
  await expectEmptySenderRules("b");
  expect(document.body.textContent).not.toContain(
    "Last routing change undone.",
  );
});

test("shared chooser defaults to actual conversation, sender action is explicit, reset inherits, guarded Undo never overwrites newer intent", async () => {
  await render(true);
  await click("Tune");
  await click("Quiet");
  await click("Save choice");
  expect(puts[0]?.body.target).toEqual({
    scope: "conversation",
    threadId: "thread-a",
  });
  expect(
    (await state("a", "&threadId=thread-a")).selection.explicitDestinationId,
  ).toBe(quietId);
  expect((await state()).senders[0]?.destinationId).toBe(fallbackId);
  await click("Tune");
  await act(async () => {
    const control = document.querySelector<HTMLSelectElement>("dialog select")!;
    control.value = "sender";
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
  await click("Quiet");
  await click("Save choice");
  expect((await state()).senders[0]?.destinationId).toBe(quietId);
  await click("Tune");
  await click("Use sender choice");
  expect((await state("a", "&threadId=thread-a")).selection).toMatchObject({
    explicitDestinationId: null,
    effective: { destinationId: quietId, source: "sender" },
  });
  const current = await state();
  await request("/v1/destinations/routing?accountId=a", {
    method: "PUT",
    body: JSON.stringify({
      expectedRevision: current.revision,
      target: { scope: "account" },
      destinationId: quietId,
    }),
  });
  await click("Undo");
  expect(
    (await state("a", "&threadId=thread-a")).selection.explicitDestinationId,
  ).toBe(null);
  expect(document.body.textContent).toContain("Undo could not be confirmed");
});

test("unknown committed response reloads canonical state without retry; failed reload locks last values", async () => {
  await render();
  let fault = true;
  intercept = async (path, init) => {
    if (init?.method === "PUT" && fault) {
      await request(path, init);
      return Response.json({}, { status: 503 });
    }
    if (path.startsWith("/v1/destinations/routing") && fault)
      return Response.json({}, { status: 403 });
  };
  await select("Destination for maya@example.com", quietId);
  expect(puts).toHaveLength(1);
  expect((await state()).senders[0]?.destinationId).toBe(quietId);
  const control = document.querySelector<HTMLSelectElement>(
    '[aria-label="Destination for maya@example.com"]',
  )!;
  expect(control.value).toBe(fallbackId);
  expect(control.disabled).toBe(true);
  expect(document.body.textContent).toContain("Save could not be confirmed");
  expect(document.body.textContent).toContain("Read-only");
  fault = false;
  await click("Reload choices");
  expect(control.disabled).toBe(false);
  expect(control.value).toBe(quietId);
  expect(puts).toHaveLength(1);
});

test("late account response cannot replace current account and discovery never creates sender rules", async () => {
  let release: (() => void) | undefined;
  intercept = async (path) => {
    if (path === "/v1/destinations/routing?accountId=a") {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return request(path);
    }
  };
  await render();
  await select("Attention account", "b");
  expect(release).toBeDefined();
  await act(async () => release!());
  await settle();
  await expectEmptySenderRules("b");
  expect((await state("b")).senders).toHaveLength(0);
  expect(puts).toHaveLength(0);
});

test("account-list failure remains visible after a successful routing reload; offline locks edits", async () => {
  intercept = async (path) =>
    path === "/v1/accounts" ? Response.json({}, { status: 503 }) : undefined;
  await render();
  expect(document.body.textContent).toContain("Could not load accounts");
  expect(button("+ Add sender").disabled).toBe(true);
  intercept = undefined;
  await click("Reload accounts");
  await act(async () => {
    Object.defineProperty(browser.navigator, "onLine", {
      configurable: true,
      value: false,
    });
    window.dispatchEvent(new Event("offline"));
  });
  expect(
    document.querySelector<HTMLSelectElement>(
      '[aria-label="Destination for maya@example.com"]',
    )!.disabled,
  ).toBe(true);
  expect(button("All senders").disabled).toBe(false);
});

test("write-only permission failure remains locked when GET succeeds until explicit recovery", async () => {
  await render();
  intercept = async (_path, init) =>
    init?.method === "PUT" ? Response.json({}, { status: 403 }) : undefined;
  await select("Destination for maya@example.com", quietId);
  expect(
    document.querySelector<HTMLSelectElement>(
      '[aria-label="Destination for maya@example.com"]',
    )!.disabled,
  ).toBe(true);
  expect(document.body.textContent).toContain("Read-only");
  intercept = undefined;
  await click("Reload choices");
  expect(
    document.querySelector<HTMLSelectElement>(
      '[aria-label="Destination for maya@example.com"]',
    )!.disabled,
  ).toBe(false);
});

test("mixed-case sender identity is normalized for shared chooser reads and writes", async () => {
  await act(async () =>
    root.render(
      <AttentionRoutingProvider onRefresh={async () => {}}>
        <RoutingChooser
          message={{
            id: "message-a",
            accountId: "a",
            threadId: "thread-a",
            from: { email: "  Maya@Example.COM  ", name: "Maya" },
          }}
        />
      </AttentionRoutingProvider>,
    ),
  );
  await click("Tune");
  await act(async () => {
    const control = document.querySelector<HTMLSelectElement>("dialog select")!;
    control.value = "sender";
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
  expect(button("Quiet").disabled).toBe(false);
  await click("Quiet");
  await click("Save choice");
  expect(puts[0]?.body.target).toEqual({
    scope: "sender",
    address: "maya@example.com",
  });
});

test("failed recovery read is not silently retried after an unknown save", async () => {
  await render();
  let reads = 0;
  intercept = async (path, init) => {
    if (init?.method === "PUT") return Response.json({}, { status: 503 });
    if (path.startsWith("/v1/destinations/routing")) {
      reads++;
      return Response.json({}, { status: 503 });
    }
  };
  await select("Destination for maya@example.com", quietId);
  await settle();
  expect(reads).toBe(1);
  expect(
    document.querySelector<HTMLSelectElement>(
      '[aria-label="Destination for maya@example.com"]',
    )!.disabled,
  ).toBe(true);
});

test("filtered sender disappearance and Undo return focus to a useful heading", async () => {
  await render();
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>(".simple-attention-choices button")!
      .click(),
  );
  const control = document.querySelector<HTMLSelectElement>(
    '[aria-label="Destination for maya@example.com"]',
  )!;
  control.focus();
  await select("Destination for maya@example.com", quietId);
  for (let attempt = 0; attempt < 50 && document.querySelector('[aria-label="Destination for maya@example.com"]'); attempt++) await settle();
  expect(document.querySelector('[aria-label="Destination for maya@example.com"]')).toBeNull();
  expect(document.activeElement?.id).toBe("sender-heading");
  await click("Undo");
  for (let attempt = 0; attempt < 50 && document.activeElement?.id !== "sender-heading"; attempt++) await settle();
  expect(document.activeElement?.id).toBe("sender-heading");
});

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
for (const outcome of ["conflict", "success"] as const) {
  test(`old Undo ${outcome} completion preserves a later save receipt`, async () => {
    await render();
    await select("Destination for maya@example.com", quietId);
    const gate = deferred();
    let held = false;
    if (outcome === "success") onRefresh = async () => {
      if (refreshes === 2) { held = true; await gate.promise; }
    };
    else intercept = async (path, init) => {
      if (init?.method !== "PUT" || held) return;
      held = true;
      await gate.promise;
      return request(path, init);
    };
    await click("Undo");
    expect(held).toBe(true);
    await select("Default destination for everyone else", quietId);
    expect(document.querySelector(".routing-feedback")?.textContent).toContain("Everyone else · Quiet.");
    await act(async () => gate.release());
    await settle();
    expect(document.querySelector(".routing-feedback")?.textContent).toContain("Everyone else · Quiet.");
    expect(button("Undo").disabled).toBe(false);
    await click("Undo");
    expect((await state()).defaultDestinationId).toBeNull();
  });
}
for (const outcome of ["committed", "rejected", "moved-focus"] as const) {
  test(`filtered sender attempted edit reconciles focus after ${outcome} ambiguous response`, async () => {
    await render();
    await select("Destination for maya@example.com", quietId);
    await act(async () => document.querySelectorAll<HTMLButtonElement>(".simple-attention-choices button")[1]!.click());
    const control = document.querySelector<HTMLSelectElement>('[aria-label="Destination for maya@example.com"]')!;
    control.focus();
    const gate = deferred();
    intercept = async (path, init) => {
      if (init?.method !== "PUT") return;
      if (outcome !== "rejected") await request(path, init);
      await gate.promise;
      return Response.json({}, { status: 503 });
    };
    await select("Destination for maya@example.com", fallbackId);
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search senders"]')!;
    if (outcome === "moved-focus") search.focus();
    await act(async () => gate.release());
    await settle(); await settle();
    expect(puts).toHaveLength(2);
    expect(document.querySelector(".routing-feedback button")?.textContent).not.toBe("Undo");
    if (outcome === "committed") {
      expect(control.isConnected).toBe(false);
      expect(document.activeElement?.id).toBe("sender-heading");
    } else if (outcome === "moved-focus") expect(document.activeElement).toBe(search);
    else {
      expect(control.isConnected).toBe(true);
      expect(document.activeElement).toBe(control);
    }
  });
}

async function renderMailbox() {
  await act(async () => root.render(<TopLayerProvider><InboxApp demoMode={false} preferences={defaultReaderPreferences} theme="light" setTheme={() => {}} /></TopLayerProvider>));
  await settle(); await settle();
}
async function nav(label: string) {
  if (label === "Signals") {
    const catalog = await (await request("/v1/destinations")).json();
    label = catalog.destinations.find((item: {id: string}) => item.id === catalog.legacyDestinationIds.notify)?.name ?? label;
  }
  const target = (label === "Signals" ? document.querySelector(".desktop-space-signals")?.closest("button") : null) ?? document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    ?? [...document.querySelectorAll<HTMLButtonElement>(".desktop-sidebar button")].find(b => b.textContent?.includes(label));
  expect(target).toBeDefined();
  await act(async () => target!.click());
  await settle();
}
function seedPages(signals = false) {
  const client = createDatabaseClient(join(directory, "test.sqlite"));
  try {
    // Seed atomically so setup does not spend the race-test budget on 210 fsyncs.
    client.db.transaction((tx) => {
      for (let i = 0; i < 105; i++) {
        tx.insert(threads).values({ id: `extra-${i}`, accountId: "a", providerThreadId: `extra-${i}`, messageCount: 1 }).run();
        tx.insert(emails).values({ id: `extra-${i}`, threadId: `extra-${i}`, accountId: "a", providerMessageId: `extra-${i}`, fromAddress: "extra@example.com", subject: `Older mail ${i}`, receivedAt: new Date(1700000000000 - i * 1000), bodyText: "Older mail" }).run();
      }
      if (signals) tx.insert(senderAttentionRules).values({ id: "extra", accountId: "a", scope: "address", value: "extra@example.com", behavior: "notify", source: "user_choice" }).run();
    });
  } finally {
    client.sqlite.close();
  }
}
function syncNoop(path: string) {
  if (path === "/v1/sync/status") return Response.json({ accounts: [] });
  if (path === "/v1/sync/gmail") return Response.json({});
}
for (const mailbox of ["Inbox", "Signals"]) {
  test(`App routing refresh releases pending ${mailbox} pagination and installs usable canonical cursor`, async () => {
    seedPages(mailbox === "Signals");
    const gate = deferred();
    let held = false;
    let delayedRoutingRead = false;
    const cursors: string[] = [];
    intercept = async (path) => {
      // Exercise readiness beyond settle() without releasing the stale page.
      if (path.startsWith("/v1/destinations/routing?") && !delayedRoutingRead) {
        delayedRoutingRead = true;
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      if (path.includes("/v1/inbox?") && path.includes("cursor=")) {
        cursors.push(new URL(path, "http://localhost").searchParams.get("cursor")!);
        if (!held) { held = true; const old = await request(path); await gate.promise; return old; }
      }
      return syncNoop(path);
    };
    await renderMailbox();
    if (mailbox === "Signals") await nav("Signals");
    await click("Load more messages");
    expect(held).toBe(true);
    await nav("Attention");
    await select("Destination for maya@example.com", quietId);
    expect(delayedRoutingRead).toBe(true);
    await nav(mailbox);
    await act(async () => gate.release());
    await settle();
    expect(document.querySelector<HTMLButtonElement>(".classification-load-more button")?.disabled).toBe(false);
    await click("Load more messages");
    expect(cursors).toHaveLength(2);
    expect(cursors[1]).not.toBe(cursors[0]);
    expect(document.body.textContent).toContain("Older mail 104");
  }, 20000);
}

test("App ignores a pre-save background snapshot after Quiet save, retaining row, count and cursor truth", async () => {
  seedPages();
  const gate = deferred();
  let snapshots = 0;
  let held = false;
  let staleCursor = "";
  const cursors: string[] = [];
  intercept = async (path) => {
    if (path.includes("/v1/inbox?") && path.includes("cursor=")) cursors.push(new URL(path, "http://localhost").searchParams.get("cursor")!);
    if (path === "/v1/inbox?view=all&classification=all&limit=100" && ++snapshots === 2) {
      const old = await request(path);
      staleCursor = (await old.clone().json()).nextCursor;
      held = true;
      await gate.promise;
      return old;
    }
    return syncNoop(path);
  };
  await renderMailbox();
  expect(held).toBe(true);
  await nav("Attention");
  await select("Destination for maya@example.com", quietId);
  await nav("Inbox");
  expect([...document.querySelectorAll(".message-row")].some(row => row.textContent?.includes("Mail a"))).toBe(false);
  const counts = () => [...document.querySelectorAll(".desktop-sidebar-item")].filter(b => b.textContent?.startsWith("Inbox") || b.textContent?.startsWith("Quiet")).map(b => b.textContent);
  const sidebarCounts = counts();
  expect(sidebarCounts).toContain("Quiet1");
  await act(async () => gate.release());
  await settle(); await settle();
  expect([...document.querySelectorAll(".message-row")].some(row => row.textContent?.includes("Mail a"))).toBe(false);
  expect(counts()).toEqual(sidebarCounts);
  await click("Load more messages");
  expect(cursors).toHaveLength(1);
  expect(cursors[0]).not.toBe(staleCursor);
  expect(document.body.textContent).toContain("Older mail 104");
}, 20000);

test("App accepts final provider status after routing invalidates its completed background snapshot", async () => {
  seedPages();
  const account = await (await request("/v1/me")).json();
  const gate = deferred();
  let snapshots = 0;
  let held = false;
  let syncs = 0;
  let staleCursor = "";
  const cursors: string[] = [];
  intercept = async (path) => {
    if (path === "/v1/sync/gmail") { syncs++; return Response.json({}); }
    if (path === "/v1/sync/status") {
      if (snapshots >= 2 && !held) {
        held = true;
        await gate.promise;
      }
      return Response.json({ accounts: [{ ...account, state: held ? "idle" : "syncing", lastSyncedAt: held ? "2026-09-13T12:00:00.000Z" : null, error: null }] });
    }
    if (path.includes("/v1/inbox?") && path.includes("cursor=")) cursors.push(new URL(path, "http://localhost").searchParams.get("cursor")!);
    if (path === "/v1/inbox?view=all&classification=all&limit=100" && ++snapshots === 2) {
      const snapshot = await request(path);
      staleCursor = (await snapshot.clone().json()).nextCursor;
      return snapshot;
    }
  };
  await renderMailbox();
  expect(held).toBe(true);
  expect(syncs).toBe(1);
  expect(document.querySelector(".sync-status-chip")?.textContent).toBe("Syncing Gmail…");
  await nav("Attention");
  await select("Destination for maya@example.com", quietId);
  await nav("Inbox");
  const rows = () => [...document.querySelectorAll(".message-row")].map(row => row.textContent);
  const counts = () => [...document.querySelectorAll(".desktop-sidebar-item")].filter(b => b.textContent?.startsWith("Inbox") || b.textContent?.startsWith("Quiet")).map(b => b.textContent);
  const canonicalRows = rows();
  const canonicalCounts = counts();
  expect(canonicalRows.some(row => row?.includes("Mail a"))).toBe(false);
  expect(canonicalCounts).toContain("Quiet1");
  expect(document.querySelector<HTMLButtonElement>(".refresh-button")?.disabled).toBe(true);
  await act(async () => gate.release());
  await settle(); await settle();
  expect(document.querySelector(".sync-status-idle")?.textContent).toStartWith("Synced ");
  expect(document.querySelector(".sync-status-syncing")).toBeNull();
  expect(document.querySelector<HTMLButtonElement>(".refresh-button")?.disabled).toBe(false);
  expect(rows()).toEqual(canonicalRows);
  expect(counts()).toEqual(canonicalCounts);
  await click("Load more messages");
  expect(cursors).toHaveLength(1);
  expect(cursors[0]).not.toBe(staleCursor);
  expect(document.body.textContent).toContain("Older mail 104");
  await act(async () => document.querySelector<HTMLButtonElement>(".refresh-button")!.click());
  await settle(); await settle();
  expect(syncs).toBe(2);
  expect(document.querySelector<HTMLButtonElement>(".refresh-button")?.disabled).toBe(false);
}, 20000);

test("delayed successful old Undo response cannot replace a newer receipt", async () => {
  await act(async () => root.render(<AttentionRoutingProvider onRefresh={async () => {}}>
    {["a", "b"].map(id => <RoutingChooser key={id} message={{ id: `message-${id}`, accountId: id, threadId: `thread-${id}`, from: { email: "maya@example.com", name: id } }} />)}
  </AttentionRoutingProvider>));
  await click("Tune"); await click("Quiet"); await click("Save choice");
  const gate = deferred();
  let held = false;
  intercept = async (path, init) => {
    if (init?.method !== "PUT" || held) return;
    held = true;
    const response = await request(path, init);
    await gate.promise;
    return response;
  };
  await click("Undo");
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Manage mail from b"]')!.click());
  await settle(); await click("Quiet"); await click("Save choice");
  await act(async () => gate.release()); await settle();
  expect(document.querySelector(".routing-feedback")?.textContent).toContain("This conversation · Quiet.");
  await click("Undo");
  expect((await state("b", "&threadId=thread-b")).selection.explicitDestinationId).toBeNull();
});


test("cancelled chooser reopening reads external routing before selecting or saving", async () => {
  await render(true);
  await click("Tune");
  expect(button("Inbox").getAttribute("aria-pressed")).toBe("true");
  await click("Cancel");
  const current = await state();
  await request("/v1/destinations/routing?accountId=a", {
    method: "PUT",
    body: JSON.stringify({ expectedRevision: current.revision, target: { scope: "conversation", threadId: "thread-a" }, destinationId: quietId }),
  });
  const gate = deferred();
  let held = false;
  intercept = async (path) => {
    if (path.includes("/v1/destinations/routing?")) { held = true; await gate.promise; }
    return undefined;
  };
  await click("Tune");
  expect(held).toBe(true);
  expect(button("Save choice").disabled).toBe(true);
  await act(async () => gate.release());
  await settle();
  expect(document.querySelector(".routing-current")?.textContent).toContain("Currently Quiet");
  expect(button("Quiet").getAttribute("aria-pressed")).toBe("true");
  expect(button("Inbox").getAttribute("aria-pressed")).toBe("false");
  await click("Save choice");
  expect(puts).toHaveLength(1);
  expect(puts[0]?.body.destinationId).toBe(quietId);
  expect((await state("a", "&threadId=thread-a")).selection.explicitDestinationId).toBe(quietId);
});

for (const entry of ["focus", "interval", "manual"] as const) {
  test(`App ${entry} provider completion refreshes Quiet rows, count and cursor and rejects old pagination`, async () => {
    seedPages();
    const current = await state();
    await request("/v1/destinations/routing?accountId=a", {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: current.revision, target: { scope: "account" }, destinationId: quietId }),
    });
    let interval: (() => void) | undefined;
    const originalInterval = browser.setInterval.bind(browser);
    browser.setInterval = ((handler: () => void, delay: number, ...args: unknown[]) => {
      if (delay === 15000) interval = handler;
      return originalInterval(handler, delay, ...args);
    }) as typeof browser.setInterval;
    const stalePage = deferred();
    const freshPage = deferred();
    const finalStatus = deferred();
    let holdStatus = false;
    let statusHeld = false;
    let syncs = 0;
    const cursors: string[] = [];
    intercept = async (path) => {
      if (path.includes(`destinationId=${encodeURIComponent(quietId)}`) && path.includes("cursor=")) {
        cursors.push(new URL(path, "http://localhost").searchParams.get("cursor")!);
        if (cursors.length === 1) { const old = await request(path); await stalePage.promise; return old; }
        if (cursors.length === 2) await freshPage.promise;
      }
      if (path === "/v1/sync/gmail") {
        syncs++;
        if (syncs === 2) {
          const client = createDatabaseClient(join(directory, "test.sqlite"));
          try {
            client.db.transaction(tx => {
              tx.insert(threads).values({ id: "incoming", accountId: "a", providerThreadId: "incoming", messageCount: 1 }).run();
              tx.insert(emails).values({ id: "incoming", threadId: "incoming", accountId: "a", providerMessageId: "incoming", fromAddress: "extra@example.com", subject: "Incoming Quiet mail", receivedAt: new Date(), bodyText: "New arrival" }).run();
            });
          } finally { client.sqlite.close(); }
          holdStatus = true;
        }
        return Response.json({});
      }
      if (path === "/v1/sync/status") {
        if (holdStatus) { holdStatus = false; statusHeld = true; await finalStatus.promise; }
        return Response.json({ accounts: [] });
      }
    };
    await renderMailbox();
    await nav("Quiet");
    expect(document.querySelector(".content-pane")?.textContent).not.toContain("Incoming Quiet mail");
    await click("Load more messages");
    expect(cursors).toHaveLength(1);
    await act(async () => {
      if (entry === "focus") window.dispatchEvent(new Event("focus"));
      else if (entry === "interval") { expect(interval).toBeDefined(); interval!(); }
      else document.querySelector<HTMLButtonElement>(".refresh-button")!.click();
    });
    const deadline = Date.now() + 2000;
    while (!statusHeld && Date.now() < deadline) await settle();
    expect(statusHeld).toBe(true);
    await act(async () => finalStatus.release());
    const refreshed = Date.now() + 2000;
    while (!document.querySelector(".content-pane")?.textContent?.includes("Incoming Quiet mail") && Date.now() < refreshed) await settle();
    expect(document.querySelector(".content-pane")?.textContent).toContain("Incoming Quiet mail");
    expect([...document.querySelectorAll(".desktop-sidebar-item")].map(b => b.textContent)).toContain("Quiet106");
    expect(document.querySelector<HTMLButtonElement>(".refresh-button")?.disabled).toBe(false);
    expect(button("Load more messages").disabled).toBe(false);
    await click("Load more messages");
    expect(cursors).toHaveLength(2);
    expect(cursors[1]).not.toBe(cursors[0]);
    await act(async () => stalePage.release());
    await settle();
    expect(document.querySelector(".content-pane")?.textContent).not.toContain("Older mail 104");
    // The superseded request must not release the newer page's busy state.
    expect(button("Loading more…").disabled).toBe(true);
    await act(async () => freshPage.release());
    await settle();
    expect(document.querySelector(".content-pane")?.textContent).toContain("Older mail 104");
    expect(document.querySelector(".content-pane")?.textContent).toContain("Incoming Quiet mail");
  }, 20000);
}

async function inputValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    const previous = input.value;
    input.value = value;
    (input as unknown as { _valueTracker?: { setValue: (value: string) => void } })._valueTracker?.setValue(previous);
    input.dispatchEvent(new browser.InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }) as unknown as Event);
  });
}

test("create from sidebar opens durable destination; sender routing covers future mail, rename keeps identity and retirement rejects references safely", async () => {
  intercept = async path => syncNoop(path);
  await renderMailbox();
  await click("New / manage");
  await inputValue(document.querySelector<HTMLInputElement>('.destination-manager input')!, "Clients");
  expect(button("Create destination").disabled, document.querySelector(".destination-manager")?.outerHTML).toBe(false);
  await click("Create destination");
  const catalog = await (await request("/v1/destinations")).json();
  const clients = catalog.destinations.find((item: {name: string}) => item.name === "Clients");
  expect(clients, document.querySelector(".destination-manager")?.outerHTML).toBeDefined();
  expect(new URL(window.location.href).searchParams.get("destination")).toBe(`destination:${clients.id}`);
  expect(document.querySelector(".content-pane")?.textContent).toContain("No mail in Clients yet");
  expect(document.querySelector(".content-pane")?.textContent).toContain("choose Clients for a sender in Attention");
  expect(document.querySelector(".content-pane")?.textContent).not.toContain("Keep useful mail together");
  expect(document.querySelector(".content-pane")?.textContent).not.toContain("When synced mail arrives");
  await nav("Attention");
  await select("Destination for maya@example.com", clients.id);
  await nav("Clients");
  expect(document.querySelector(".content-pane")?.textContent).toContain("Mail a");
  expect(document.querySelector(".content-pane")?.textContent).not.toContain("Mail b");
  const client = createDatabaseClient(join(directory, "test.sqlite"));
  try {
    client.db.insert(threads).values({ id: "future", accountId: "a", providerThreadId: "future", messageCount: 1 }).run();
    client.db.insert(emails).values({ id: "future", accountId: "a", threadId: "future", providerMessageId: "future", fromAddress: "maya@example.com", subject: "Future client mail", receivedAt: new Date(), bodyText: "Next project" }).run();
  } finally { client.sqlite.close(); }
  await act(async () => window.dispatchEvent(new Event("focus")));
  for (let i = 0; i < 50 && !document.querySelector(".content-pane")?.textContent?.includes("Future client mail"); i++) await settle();
  expect(document.querySelector(".content-pane")?.textContent).toContain("Future client mail");
  await click("New / manage");
  const details = [...document.querySelectorAll(".destination-manager details")].find(item => item.querySelector("summary")?.textContent === "Clients")!;
  await inputValue(details.querySelector<HTMLInputElement>("input")!, "Partners");
  await act(async () => details.querySelector<HTMLButtonElement>("button")!.click());
  await settle();
  expect(document.querySelector(".desktop-sidebar")?.textContent).toContain("Partners");
  expect((await state()).senders[0]?.destinationId).toBe(clients.id);
  await act(async () => [...details.querySelectorAll<HTMLButtonElement>("button")].find(item => item.getAttribute("aria-label") === "Remove Partners")!.click());
  await settle();
  expect(document.querySelector(".desktop-sidebar")?.textContent).toContain("Partners");
  expect(document.querySelector(".destination-manager [role=alert]")).not.toBeNull();
  const latest = await state();
  await request("/v1/destinations/routing?accountId=a", { method: "PUT", body: JSON.stringify({ expectedRevision: latest.revision, target: { scope: "sender", address: "maya@example.com" }, destinationId: null }) });
  await act(async () => refreshDestinations());
  await act(async () => [...details.querySelectorAll<HTMLButtonElement>("button")].find(item => item.getAttribute("aria-label") === "Remove Partners")!.click());
  await settle();
  expect(document.querySelector(".desktop-sidebar")?.textContent).not.toContain("Partners");
  const retired = await (await request("/v1/destinations")).json();
  expect(retired.destinations.find((item: {id: string}) => item.id === clients.id).retiredAt).not.toBeNull();
  const page = await (await request(`/v1/inbox?view=all&classification=all&destinationId=${fallbackId}`)).json();
  expect(page.messages.some((item: {subject: string}) => item.subject === "Future client mail")).toBe(true);
}, 20000);

test("destination URL survives reader open, close and history while canonical pages exceed first hundred", async () => {
  seedPages();
  const current = await state();
  await request("/v1/destinations/routing?accountId=a", { method: "PUT", body: JSON.stringify({ expectedRevision: current.revision, target: { scope: "account" }, destinationId: quietId }) });
  window.history.replaceState(null, "", `/?destination=${encodeURIComponent(`destination:${quietId}`)}`);
  intercept = async path => syncNoop(path);
  await renderMailbox();
  await click("Load more messages");
  expect(document.querySelector(".content-pane")?.textContent).toContain("Older mail 104");
  await act(async () => document.querySelector<HTMLButtonElement>(".message-row")!.click());
  await settle();
  expect(new URL(window.location.href).searchParams.get("destination")).toBe(`destination:${quietId}`);
  expect(new URL(window.location.href).searchParams.get("accountId")).toBe("a");
  expect(new URL(window.location.href).searchParams.get("thread")).toBeTruthy();
  await act(async () => document.querySelector<HTMLButtonElement>(".reader-back")!.click());
  await settle();
  expect(new URL(window.location.href).searchParams.get("thread")).toBeNull();
  expect(new URL(window.location.href).searchParams.get("destination")).toBe(`destination:${quietId}`);
  await act(async () => window.history.forward());
  await settle();
  expect(new URL(window.location.href).searchParams.get("thread")).toBeTruthy();
  expect(document.querySelector(".reader-back")?.textContent).toContain("Quiet");
}, 20000);

test("same-destination refresh retains an open chooser and explicit unsaved choice", async () => {
  intercept = async path => syncNoop(path);
  await renderMailbox();
  await act(async () => document.querySelector<HTMLButtonElement>(".sender-attention-trigger")!.click());
  await settle();
  await click("Quiet");
  const chooser = document.querySelector(".routing-chooser");
  expect(chooser).not.toBeNull();
  const pageGate = deferred();
  let requested = false;
  intercept = async path => {
    if (path.includes("destinationId=") && !path.includes("cursor=")) {
      requested = true;
      await pageGate.promise;
    }
    return syncNoop(path);
  };
  await act(async () => window.dispatchEvent(new Event("focus")));
  const deadline = Date.now() + 2000;
  while (!requested && Date.now() < deadline) await settle();
  expect(requested).toBe(true);
  expect(document.querySelector(".routing-chooser")).toBe(chooser);
  expect(button("Quiet").getAttribute("aria-pressed")).toBe("true");
  await act(async () => pageGate.release());
  await settle();
  expect(document.querySelector(".routing-chooser")).toBe(chooser);
  expect(button("Quiet").getAttribute("aria-pressed")).toBe("true");
  await click("Save choice");
  expect(puts.at(-1)?.body.destinationId).toBe(quietId);
}, 20000);

for (const destination of ["Inbox", "Quiet"]) {
  test(`opening unread mail updates the ${destination} page and canonical catalog count`, async () => {
    if (destination === "Quiet") {
      const current = await state();
      await request("/v1/destinations/routing?accountId=a", { method: "PUT", body: JSON.stringify({ expectedRevision: current.revision, target: { scope: "conversation", threadId: "thread-a" }, destinationId: quietId }) });
    }
    intercept = async path => syncNoop(path);
    await renderMailbox();
    if (destination === "Quiet") await nav("Quiet");
    const row = [...document.querySelectorAll<HTMLButtonElement>(".message-row")].find(item => item.textContent?.includes("Mail a"))!;
    expect(row.classList.contains("message-row-unread")).toBe(true);
    await act(async () => row.click());
    await settle();
    await act(async () => document.querySelector<HTMLButtonElement>(".reader-back")!.click());
    await settle();
    const updated = [...document.querySelectorAll<HTMLButtonElement>(".message-row")].find(item => item.textContent?.includes("Mail a"))!;
    expect(updated.classList.contains("message-row-unread")).toBe(false);
    const catalog = await (await request("/v1/destinations")).json();
    const id = destination === "Quiet" ? quietId : catalog.fallbackDestinationId;
    expect(catalog.destinations.find((item: {id: string}) => item.id === id).counts.unread).toBe(destination === "Quiet" ? 0 : 1);
    expect(document.querySelector(".desktop-sidebar")?.textContent).toContain(`${destination}${destination === "Quiet" ? 1 : 2}`);
  });
}

test("destination switches clear hidden selections and actionable sender targets", async () => {
  const current = await state();
  await request("/v1/destinations/routing?accountId=a", { method: "PUT", body: JSON.stringify({ expectedRevision: current.revision, target: { scope: "conversation", threadId: "thread-a" }, destinationId: quietId }) });
  intercept = async path => syncNoop(path);
  await renderMailbox();
  await click("Select");
  await act(async () => document.querySelector<HTMLButtonElement>(".message-row")!.click());
  expect(button("Use these senders").disabled).toBe(false);
  await nav("Quiet");
  expect(document.querySelector(".bulk-selection-toolbar")).toBeNull();
  expect([...document.querySelectorAll("button")].some(item => item.textContent === "Use these senders")).toBe(false);
  await click("Select");
  await act(async () => document.querySelector<HTMLButtonElement>(".message-row")!.click());
  expect(button("Use these senders").disabled).toBe(false);
  await nav("Inbox");
  expect([...document.querySelectorAll("button")].some(item => item.textContent === "Use these senders")).toBe(false);
  expect(puts).toHaveLength(0);
});
