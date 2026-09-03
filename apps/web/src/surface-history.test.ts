import { describe, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import {
  ORCA_SURFACE_HISTORY_KEY,
  SurfaceHistory,
  canRestoreSurfaceFocus,
  captureSurfaceReturnContext,
  readSurfaceHistoryMetadata,
  readSurfaceLocation,
  restoreWorkspaceScroll,
} from "./surface-history";

function createBrowser(url: string) {
  return new HappyWindow({ url });
}

function settleHistory() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("surface history contract", () => {
  test("reads legacy path links and keeps destination, query, and unknown parameters", () => {
    const browser = createBrowser("http://localhost:5173/accounts/account%201/threads/thread%2F1?destination=space%3Alaunch&q=moon&flag=kept#message-1");
    expect(readSurfaceLocation(browser.location)).toEqual({
      destination: "space:launch",
      query: "moon",
      reader: { accountId: "account 1", threadId: "thread/1" },
      composer: null,
    });
    browser.close();
  });

  test("seeds a clean in-app predecessor for an initial deep link", async () => {
    const browser = createBrowser("http://localhost:5173/dev/inbox?destination=focus&q=ledger&thread=thread-1&accountId=account-1&flag=kept#mail");
    const history = new SurfaceHistory(browser as never);
    history.initialize();

    expect(readSurfaceHistoryMetadata(browser.history.state)?.canDismiss).toBe(true);
    expect(browser.location.search).toContain("thread=thread-1");
    browser.history.back();
    await settleHistory();

    const params = new URL(browser.location.href).searchParams;
    expect(params.get("thread")).toBeNull();
    expect(params.get("accountId")).toBeNull();
    expect(params.get("destination")).toBe("focus");
    expect(params.get("q")).toBe("ledger");
    expect(params.get("flag")).toBe("kept");
    expect(browser.location.hash).toBe("#mail");
    browser.close();
  });

  test("makes preference-driven Zen explicit in an initial Compose URL", async () => {
    const browser = createBrowser("http://localhost:5173/?compose=1&flag=kept");
    const history = new SurfaceHistory(browser as never);
    history.initialize({ defaultComposerZen: true });

    expect(readSurfaceLocation(browser.location).composer).toEqual({ draftId: null, zen: true });
    expect(new URL(browser.location.href).searchParams.get("zen")).toBe("1");
    browser.history.back();
    await settleHistory();
    expect(readSurfaceLocation(browser.location).composer).toEqual({ draftId: null, zen: false });
    browser.history.forward();
    await settleHistory();
    expect(readSurfaceLocation(browser.location).composer).toEqual({ draftId: null, zen: true });
    browser.close();
  });

  test("nests reader, composer, and Zen so Back and Forward dismiss one owned surface", async () => {
    const browser = createBrowser("http://localhost:5173/dev/inbox?destination=space%3Alaunch&q=moon&flag=kept");
    const history = new SurfaceHistory(browser as never);
    history.initialize();
    history.openReader({ threadId: "thread/1", accountId: "account 1" }, {
      workspaceX: 7,
      workspaceY: 418,
      target: { kind: "message", id: "message-1" },
    });
    history.openComposer({ draftId: "draft/1", zen: false });
    history.openZen();
    history.replaceQuery("updated query");

    expect(readSurfaceLocation(browser.location).composer).toEqual({ draftId: "draft/1", zen: true });
    expect(readSurfaceLocation(browser.location).reader?.threadId).toBe("thread/1");
    expect(readSurfaceLocation(browser.location).query).toBe("updated query");
    expect(new URL(browser.location.href).searchParams.get("flag")).toBe("kept");

    browser.history.back();
    await settleHistory();
    expect(readSurfaceLocation(browser.location).composer).toEqual({ draftId: "draft/1", zen: false });
    browser.history.back();
    await settleHistory();
    expect(readSurfaceLocation(browser.location).composer).toBeNull();
    expect(readSurfaceLocation(browser.location).reader?.threadId).toBe("thread/1");
    expect(history.dismiss("composer")).toEqual({ mode: "replace", location: history.read() });
    expect(readSurfaceLocation(browser.location).reader?.threadId).toBe("thread/1");
    browser.history.back();
    await settleHistory();
    expect(readSurfaceLocation(browser.location).reader).toBeNull();
    expect(new URL(browser.location.href).searchParams.get("flag")).toBe("kept");

    browser.history.forward();
    await settleHistory();
    expect(readSurfaceLocation(browser.location).reader?.threadId).toBe("thread/1");
    browser.close();
  });

  test("consumes reader return context exactly once without rewriting the destination entry", async () => {
    const browser = createBrowser("http://localhost:5173/dev/inbox?destination=focus");
    const history = new SurfaceHistory(browser as never);
    const returnContext = {
      workspaceX: 7,
      workspaceY: 418,
      target: { kind: "message", id: "message-1" } as const,
    };
    history.initialize();
    history.openReader({ threadId: "thread-1", accountId: "account-1" }, returnContext);

    browser.history.back();
    await settleHistory();
    expect(history.consumeReturnContext()).toEqual(returnContext);
    expect(history.consumeReturnContext()).toBeNull();
    expect(history.lastReturnTarget()).toEqual(returnContext.target);
    expect(readSurfaceHistoryMetadata(browser.history.state)?.returnContext).toBeNull();
    browser.history.forward();
    await settleHistory();
    expect(readSurfaceLocation(browser.location).reader?.threadId).toBe("thread-1");
    const rearmedContext = { ...returnContext, workspaceX: 19, workspaceY: 522 };
    history.armReturnContext(rearmedContext);
    browser.history.back();
    await settleHistory();
    expect(history.consumeReturnContext()).toEqual(rearmedContext);
    expect(history.consumeReturnContext()).toBeNull();
    browser.close();
  });

  test("replaces stale surface parameters when an unowned deep link is closed", () => {
    const browser = createBrowser("http://localhost:5173/dev/inbox?thread=thread-1&accountId=account-1&compose=1&draft=draft-1&flag=kept");
    const history = new SurfaceHistory(browser as never);
    const result = history.dismiss("composer");

    expect(result.mode).toBe("replace");
    const params = new URL(browser.location.href).searchParams;
    expect(params.get("compose")).toBeNull();
    expect(params.get("draft")).toBeNull();
    expect(params.get("thread")).toBe("thread-1");
    expect(params.get("flag")).toBe("kept");
    expect((browser.history.state as Record<string, unknown> | null)?.[ORCA_SURFACE_HISTORY_KEY]).toBeDefined();
    browser.close();
  });

  test("replaces an invalid custom-space surface with one clean fallback entry", () => {
    const browser = createBrowser("http://localhost:5173/dev/inbox?destination=space%3Amissing&q=ledger&thread=thread-1&accountId=account-1&compose=1&zen=1&flag=kept#mail");
    const history = new SurfaceHistory(browser as never);
    const next = history.replaceDestination("inbox");

    expect(next).toEqual({
      destination: "inbox",
      query: "ledger",
      reader: null,
      composer: null,
    });
    const url = new URL(browser.location.href);
    expect(url.pathname).toBe("/dev/inbox");
    expect(url.searchParams.get("flag")).toBe("kept");
    expect(url.hash).toBe("#mail");
    expect(readSurfaceHistoryMetadata(browser.history.state)?.canDismiss).toBe(false);
    browser.close();
  });

  test("captures the desktop scroll owner and restores focus only to a safe target", () => {
    const browser = createBrowser("http://localhost:5173/dev/inbox");
    try {
      const workspace = browser.document.createElement("section");
      workspace.className = "desktop-workspace";
      workspace.scrollLeft = 11;
      workspace.scrollTop = 377;
      const row = browser.document.createElement("button");
      workspace.append(row);
      browser.document.body.append(workspace);

      const context = captureSurfaceReturnContext({ kind: "message", id: "message-1" }, browser.document as never);
      expect(context).toEqual({ workspaceX: 11, workspaceY: 377, target: { kind: "message", id: "message-1" } });
      workspace.scrollLeft = 0;
      workspace.scrollTop = 0;
      expect(restoreWorkspaceScroll(context, browser.document as never)).toBe(true);
      expect([workspace.scrollLeft, workspace.scrollTop]).toEqual([11, 377]);
      const getStyle = browser.getComputedStyle.bind(browser);
      expect(canRestoreSurfaceFocus(row as never, getStyle as never)).toBe(true);
      workspace.inert = true;
      expect(canRestoreSurfaceFocus(row as never, getStyle as never)).toBe(false);
      row.remove();
      expect(canRestoreSurfaceFocus(row as never, getStyle as never)).toBe(false);
    } finally {
      browser.close();
    }
  });
});
