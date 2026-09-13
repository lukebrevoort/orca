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
import { AttentionPage } from "./attention-page";
import { AttentionRoutingProvider } from "./attention-routing";
import { RoutingChooser } from "./routing-chooser";
import { attentionRoutingStateSchema } from "@orca/shared";
const globals = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
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
  let result!: ReturnType<typeof attentionRoutingStateSchema.parse>;
  await act(async () => {
    result = attentionRoutingStateSchema.parse(
      await (
        await request(`/v1/attention/routing?accountId=${account}${query}`)
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
        }}
      >
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
  expect(found).toBeDefined();
  return found!;
}
async function click(text: string) {
  await act(async () => button(text).click());
  await settle();
}
async function select(label: string, value: string) {
  await act(async () => {
    const select = document.querySelector<HTMLSelectElement>(
      `[aria-label="${label}"]`,
    )!;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

test("page saves actual sender routing, refreshes consumers, Undo restores prior explicit state, accounts isolated", async () => {
  await render();
  await select("Destination for maya@example.com", "quiet");
  expect((await state()).senders[0]?.behavior).toBe("quiet");
  expect((await state("b")).senders).toHaveLength(0);
  expect(puts[0]?.body).toMatchObject({
    target: { scope: "sender", address: "maya@example.com" },
    expectedRevision: 1,
  });
  expect(refreshes).toBe(1);
  await click("Undo");
  expect((await state()).senders[0]?.behavior).toBe("normal");
  await select("Attention account", "b");
  expect(document.body.textContent).not.toContain("maya@example.com");
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
    (await state("a", "&threadId=thread-a")).selection.explicitBehavior,
  ).toBe("quiet");
  expect((await state()).senders[0]?.behavior).toBe("normal");
  await click("Tune");
  await act(async () => {
    const control = document.querySelector<HTMLSelectElement>("dialog select")!;
    control.value = "sender";
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
  await click("Quiet");
  await click("Save choice");
  expect((await state()).senders[0]?.behavior).toBe("quiet");
  await click("Tune");
  await click("Use sender choice");
  expect((await state("a", "&threadId=thread-a")).selection).toMatchObject({
    explicitBehavior: null,
    effective: { behavior: "quiet", source: "sender" },
  });
  const current = await state();
  await request("/v1/attention/routing?accountId=a", {
    method: "PUT",
    body: JSON.stringify({
      expectedRevision: current.revision,
      target: { scope: "account" },
      behavior: "quiet",
    }),
  });
  await click("Undo");
  expect(
    (await state("a", "&threadId=thread-a")).selection.explicitBehavior,
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
    if (path.startsWith("/v1/attention/routing") && fault)
      return Response.json({}, { status: 403 });
  };
  await select("Destination for maya@example.com", "quiet");
  expect(puts).toHaveLength(1);
  expect((await state()).senders[0]?.behavior).toBe("quiet");
  const control = document.querySelector<HTMLSelectElement>(
    '[aria-label="Destination for maya@example.com"]',
  )!;
  expect(control.value).toBe("normal");
  expect(control.disabled).toBe(true);
  expect(document.body.textContent).toContain("Save could not be confirmed");
  expect(document.body.textContent).toContain("Read-only");
  fault = false;
  await click("Reload choices");
  expect(control.disabled).toBe(false);
  expect(control.value).toBe("quiet");
  expect(puts).toHaveLength(1);
});

test("late account response cannot replace current account and discovery never creates sender rules", async () => {
  let release: (() => void) | undefined;
  intercept = async (path) => {
    if (path === "/v1/attention/routing?accountId=a") {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return request(path);
    }
  };
  await render();
  await select("Attention account", "b");
  await act(async () => release?.());
  await settle();
  expect(document.body.textContent).not.toContain("maya@example.com");
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
  await select("Destination for maya@example.com", "quiet");
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
    if (path.startsWith("/v1/attention/routing")) {
      reads++;
      return Response.json({}, { status: 503 });
    }
  };
  await select("Destination for maya@example.com", "quiet");
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
  await select("Destination for maya@example.com", "quiet");
  for (let attempt = 0; attempt < 50 && document.querySelector('[aria-label="Destination for maya@example.com"]'); attempt++) await settle();
  expect(document.querySelector('[aria-label="Destination for maya@example.com"]')).toBeNull();
  expect(document.activeElement?.id).toBe("sender-heading");
  await click("Undo");
  for (let attempt = 0; attempt < 50 && document.activeElement?.id !== "sender-heading"; attempt++) await settle();
  expect(document.activeElement?.id).toBe("sender-heading");
});
