import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";

const ixdRoot = import.meta.dir;

function readPrototype(name: string) {
  return readFileSync(join(ixdRoot, name), "utf8");
}

async function mountPrototype(name: string, setup?: (window: Window) => void) {
  const html = readPrototype(name);
  const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  const window = new Window({
    url: "http://localhost/organization",
    settings: { disableJavaScriptEvaluation: false },
  });
  window.document.write(html.replace(/<script>[\s\S]*?<\/script>/, ""));
  setup?.(window);
  Function("window", "document", inlineScript)(window, window.document);
  await window.happyDOM.waitUntilComplete();
  return window;
}

describe("BRE-307 Organization prototypes", () => {
  test("desktop prototype preserves the approved Organization direction", () => {
    const html = readPrototype("phase7-prototype-desktop.html");
    for (const term of ["Glass Box", "Tide Table", "Simulate", "Activate", "Trace", "Audit history", "Revert"]) expect(html).toContain(term);
    expect(html).toContain("user approved");
    expect(html).toContain('data-theme="light"');
    expect(html).toContain('data-scenario="default"');
  });

  test("mobile prototype is historical compatibility evidence, not approved direction", () => {
    const html = readPrototype("phase7-prototype-mobile.html");
    expect(html).toContain("Historical mobile compatibility · deferred");
    expect(html).not.toContain("user approved");
  });

  for (const file of ["phase7-prototype-desktop.html", "phase7-prototype-mobile.html"]) {

    test(`${file} exposes required state contracts`, () => {
      const html = readPrototype(file);

      for (const state of [
        "default",
        "loading",
        "empty",
        "no-access",
        "partial-load",
        "stale",
        "offline",
        "simulated",
        "active",
        "conflict",
        "error",
      ]) {
        expect(html).toContain(`value="${state}"`);
      }

      expect(html).toMatch(/:hover/);
      expect(html).toMatch(/:focus-visible/);
      expect(html).toMatch(/\[aria-pressed="true"\]/);
      expect(html).toMatch(/:disabled/);
      expect(html).toContain('aria-pressed="true"');
      expect(html).toContain('aria-live="polite"');
      expect(html).toContain('data-operational-state');
    });

    test(`${file} is a self-contained interactive artifact`, () => {
      const html = readPrototype(file);

      expect(html).toContain("<style>");
      expect(html).toContain("<script>");
      expect(html).not.toMatch(/<script[^>]+src=/);
      expect(html).not.toMatch(/<link[^>]+stylesheet/);
      expect(html).toContain("data-action=\"simulate\"");
      expect(html).toContain("data-action=\"activate\"");
      expect(html).toContain("data-action=\"revert\"");
    });

    test(`${file} shares one draft and scenario state model`, () => {
      const html = readPrototype(file);

      expect(html).toContain("const draftModel");
      expect(html).toContain("renderDraft");
      expect(html).toContain("markSimulationStale");
      expect(html).toContain("data-rule-picker");
      expect(html).toContain("data-action=\"new-rule\"");
      expect(html).toContain("data-edit-field");
      expect(html).toContain("data-revision-chip");
      expect(html).toContain("data-rule-meta");
      expect(html).toContain("data-audit-event");
      expect(html).toContain("data-rule-source");
      expect(html).toContain("serializeDraft");
      expect(html).toContain("persistDraft");
      expect(html).toContain("data-trace-rule");
      expect(html).toContain("data-revert-label");
    });

    test(`${file} exposes the complete five-step precedence law`, () => {
      const html = readPrototype(file);
      const steps = ["Safety lock", "Manual override", "Winning rule", "Lane policy", "Workspace / fallback"];
      let previous = -1;

      for (const step of steps) {
        const next = html.indexOf(step);
        expect(next).toBeGreaterThan(previous);
        previous = next;
      }
    });
  }

  test("prototype navigation and selection semantics are valid", () => {
    const desktop = readPrototype("phase7-prototype-desktop.html");
    const mobile = readPrototype("phase7-prototype-mobile.html");

    expect(desktop).toContain('aria-current="page"');
    expect(desktop).not.toMatch(/<button[^>]+aria-selected=/);
    expect(desktop).toContain('class="rule-row" aria-pressed="true"');
    expect(mobile).toContain('role="tablist"');
    expect(mobile).toContain('role="tab"');
    expect(mobile).toContain('role="tabpanel"');
    expect(mobile).toContain('aria-current="page"');
  });

  test("desktop prototype encodes the user-approved direction decisions", () => {
    const desktop = readPrototype("phase7-prototype-desktop.html");
    const handoff = readPrototype("phase8-document.md");
    const components = readPrototype("phase5-components.md");
    const approval = readPrototype("user-direction-review.html");

    for (const stage of ["when", "if", "then", "because"]) {
      expect(desktop).toContain(`data-stage="${stage}"`);
    }
    expect(desktop).toContain('data-inspector data-open="false"');
    expect(desktop).toContain("data-inspector-pin");
    expect(desktop).toContain("data-simulation-details");
    expect(desktop).toContain('data-user-space="focus"');
    expect(desktop).toContain('draggable="true"');
    expect(handoff).toContain("mobile is deferred to a separate rebranding milestone");
    expect(handoff).toContain("Hidden-by-default desktop evidence drawer");
    expect(handoff).toContain("BRE-321");
    expect(components).toContain("Evidence drawer and Trace chain");
    expect(components).toContain("1280px and wider");
    expect(components).toContain("mobile receives a separate rebranding milestone");
    expect(components).not.toContain("Persistent library, workbench, and inspector");
    expect(approval).toContain("Desktop direction explicitly approved");
    expect(approval).toContain("Approved August 23, 2026");
    expect(handoff).toContain("Implementation gate**: Open");
  });

  test("desktop evidence drawer opens contextually, pins, and keeps simulation evidence expandable", async () => {
    const window = await mountPrototype("phase7-prototype-desktop.html", window => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440, writable: true });
    });
    const inspector = window.document.querySelector<HTMLElement>("[data-inspector]");
    const workspace = window.document.querySelector<HTMLElement>(".workspace");
    const pin = window.document.querySelector<HTMLButtonElement>("[data-inspector-pin]");
    const details = window.document.querySelector<HTMLElement>("[data-simulation-details]");
    const evidence = window.document.querySelector<HTMLButtonElement>("[data-simulation-toggle]");

    expect(inspector?.dataset.open).toBe("false");
    expect(inspector?.getAttribute("aria-hidden")).toBe("true");
    const invoker = window.document.querySelector<HTMLButtonElement>('[data-inspector-open="trace"]');
    invoker?.focus();
    invoker?.click();
    expect(inspector?.dataset.open).toBe("true");
    expect(inspector?.getAttribute("aria-hidden")).toBe("false");
    expect(window.document.activeElement).toBe(window.document.querySelector("[data-inspector-close]"));
    pin?.click();
    expect(workspace?.dataset.inspectorPinned).toBe("true");
    expect(pin?.getAttribute("aria-pressed")).toBe("true");

    window.document.querySelector<HTMLButtonElement>('[data-action="simulate"]')?.click();
    expect(window.document.querySelector("[data-sim-label]")?.textContent).toContain("2,418 threads");
    expect(details?.hidden).toBe(true);
    evidence?.click();
    expect(details?.hidden).toBe(false);
    expect(evidence?.getAttribute("aria-expanded")).toBe("true");
    expect(details?.textContent).toContain("Conflicts");
    expect(details?.textContent).toContain("Risk");
    expect(details?.textContent).toContain("Authority");
    window.document.querySelector<HTMLButtonElement>("[data-inspector-close]")?.click();
    expect(window.document.activeElement).toBe(invoker);
    await window.close();
  });

  test("desktop drawer refuses narrow pinning and restores a saved wide-screen preference", async () => {
    const narrow = await mountPrototype("phase7-prototype-desktop.html", window => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1100, writable: true });
      window.localStorage.setItem("orca.organization.inspectorPinned", "true");
    });
    narrow.document.querySelector<HTMLButtonElement>('[data-inspector-open="trace"]')?.click();
    expect(narrow.document.querySelector<HTMLButtonElement>("[data-inspector-pin]")?.disabled).toBe(true);
    expect(narrow.document.querySelector<HTMLElement>(".workspace")?.dataset.inspectorPinned).toBe("false");
    await narrow.close();

    const wide = await mountPrototype("phase7-prototype-desktop.html", window => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440, writable: true });
      window.localStorage.setItem("orca.organization.inspectorPinned", "true");
    });
    expect(wide.document.querySelector<HTMLElement>("[data-inspector]")?.dataset.open).toBe("true");
    expect(wide.document.querySelector<HTMLElement>(".workspace")?.dataset.inspectorPinned).toBe("true");
    expect(wide.document.querySelector<HTMLButtonElement>("[data-inspector-pin]")?.disabled).toBe(false);
    wide.document.querySelector<HTMLButtonElement>("[data-inspector-close]")?.click();
    expect(wide.document.activeElement).toBe(wide.document.querySelector('[data-inspector-open="trace"]'));
    await wide.close();
  });

  test("user-owned spaces support keyboard reordering and persist the new order", async () => {
    const window = await mountPrototype("phase7-prototype-desktop.html");
    const signals = window.document.querySelector<HTMLElement>('[data-user-space="signals"]');
    signals?.focus();
    signals?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }));
    const order = [...window.document.querySelectorAll<HTMLElement>("[data-user-space]")].map(space => space.dataset.userSpace);

    expect(order).toEqual(["signals", "focus", "quiet", "later"]);
    expect(window.document.querySelector("[data-space-status]")?.textContent).toContain("Signals moved to position 1 of 4");
    expect(window.localStorage.getItem("orca.navigation.userSpaceOrder")).toBe(JSON.stringify(order));
    expect(window.document.activeElement).toBe(signals);
    await window.close();
  });

  test("mobile prototype declares 44px minimum targets", () => {
    const mobile = readPrototype("phase7-prototype-mobile.html");

    expect(mobile).toContain("button, select, input, textarea { min-height: 44px;");
    expect(mobile).not.toMatch(/min-height:\s*(?:3[0-9]|[0-2][0-9])px/);
    expect(mobile).not.toMatch(/font-size:\s*(?:8|9|10)px/);
  });

  test("prototypes use Orca's effective Tidal token cascade", () => {
    for (const file of ["phase7-prototype-desktop.html", "phase7-prototype-mobile.html"]) {
      const html = readPrototype(file);
      expect(html).toContain("--color-foam: #f7faf8");
      expect(html).toContain("--color-current: #0f2422");
      expect(html).toContain("--orca-ink: var(--color-current)");
      expect(html).toContain('--font-body: "Sora"');
      expect(html).toContain("--color-foam: #111a22");
      expect(html).not.toContain("--orca-paper: #f7f7f5");
    }
    const handoff = readPrototype("phase5-components.md");
    expect(handoff).toContain("0 18px 54px rgb(15 36 34 / 12%)");
    expect(handoff).toContain("0 22px 64px rgb(0 0 0 / 34%)");
    expect(handoff).not.toContain("0 24px 80px rgba(10,10,11,.16)");
  });

  for (const file of ["phase7-prototype-desktop.html", "phase7-prototype-mobile.html"]) {
    test(`${file} makes structured edits stale and keeps theme switching available`, async () => {
      const window = await mountPrototype(file);
      const edit = window.document.querySelector<HTMLButtonElement>('[data-edit-field="if"]');
      const activate = window.document.querySelector<HTMLButtonElement>('[data-action="activate"]');
      const theme = window.document.querySelector<HTMLButtonElement>("[data-theme-toggle]");

      edit?.click();
      expect(window.document.body.dataset.scenario).toBe("stale");
      expect(window.document.querySelector('[data-draft-field="if"]')?.textContent).toContain("refined");
      expect(window.document.querySelector("[data-revision-chip]")?.textContent).toContain("simulation stale");
      expect(window.document.querySelector<HTMLTextAreaElement>("[data-rule-source]")?.value).toContain("refined");
      expect(activate?.disabled).toBe(true);
      theme?.click();
      expect(window.document.body.dataset.theme).toBe("dark");
      await window.close();
    });
  }

  test("desktop picker and New rule render through the shared draft model", async () => {
    const window = await mountPrototype("phase7-prototype-desktop.html");

    window.document.querySelector<HTMLButtonElement>('[data-rule-id="purchases"]')?.click();
    expect(window.document.querySelector("[data-rule-title]")?.textContent).toBe("Quiet purchase confirmations");
    expect(window.document.querySelector('[data-rule-id="purchases"]')?.getAttribute("aria-pressed")).toBe("true");
    window.document.querySelector<HTMLButtonElement>('[data-action="new-rule"]')?.click();
    expect(window.document.querySelector("[data-rule-title]")?.textContent).toBe("Untitled organization rule");
    expect(window.document.querySelector<HTMLTextAreaElement>("[data-rule-source]")?.value).toContain("rule new");
    expect(window.document.body.dataset.scenario).toBe("stale");
    await window.close();
  });

  test("desktop whiteboard pieces add rule structure and stale the simulation", async () => {
    const window = await mountPrototype("phase7-prototype-desktop.html");
    window.document.querySelector<HTMLButtonElement>('[data-add-piece="if"]')?.click();

    expect(window.document.querySelector('[data-draft-field="if"]')?.textContent).toContain("thread is unresolved");
    expect(window.document.querySelector<HTMLTextAreaElement>("[data-rule-source]")?.value).toContain("thread is unresolved");
    expect(window.document.body.dataset.scenario).toBe("stale");
    expect(window.document.querySelector("[data-save-state]")?.textContent).toContain("Condition piece changed");
    await window.close();
  });

  test("desktop When edits round-trip into Tide source", async () => {
    const window = await mountPrototype("phase7-prototype-desktop.html");
    const source = window.document.querySelector<HTMLTextAreaElement>("[data-rule-source]");
    const before = source?.value;
    window.document.querySelector<HTMLButtonElement>('[data-edit-field="when"]')?.click();
    expect(source?.value).not.toBe(before);
    expect(source?.value).toContain("A thread receives a new message · refined");
    expect(window.document.body.dataset.scenario).toBe("stale");
    await window.close();
  });

  test("mobile picker updates title, revision, and activation gate together", async () => {
    const window = await mountPrototype("phase7-prototype-mobile.html");
    const picker = window.document.querySelector<HTMLSelectElement>("[data-rule-picker]");

    if (picker) {
      picker.value = "pulls";
      picker.dispatchEvent(new window.Event("change", { bubbles: true }));
    }
    expect(window.document.querySelector("[data-rule-title]")?.textContent).toBe("Focus requested pull-request reviews");
    expect(window.document.querySelector("[data-revision-chip]")?.textContent).toContain("rev 12 · active");
    expect(window.document.querySelector("[data-trace-rule]")?.textContent).toBe("Pull request mentions · priority 24 · revision 12");
    expect(window.document.querySelector("[data-revert-label]")?.textContent).toContain("revision 11");
    expect(window.document.querySelector("[data-revert-title]")?.textContent).toBe("Revert Pull request mentions?");
    expect(window.document.querySelector<HTMLTextAreaElement>("[data-rule-source]")?.value).toContain("rule pulls");
    expect(window.document.querySelector<HTMLButtonElement>('[data-action="revert"]')?.disabled).toBe(false);
    expect(window.document.querySelector<HTMLButtonElement>('[data-action="activate"]')?.disabled).toBe(true);
    await window.close();
  });

  test("desktop active selection derives Trace and revert target from the same model", async () => {
    const window = await mountPrototype("phase7-prototype-desktop.html");
    window.document.querySelector<HTMLButtonElement>('[data-rule-id="pulls"]')?.click();

    expect(window.document.querySelector("[data-rule-title]")?.textContent).toBe("Focus requested pull-request reviews");
    expect(window.document.querySelector("[data-revision-chip]")?.textContent).toContain("rev 12 · active");
    expect(window.document.querySelector("[data-trace-rule]")?.textContent).toBe("Pull request mentions · priority 24 · revision 12");
    expect(window.document.querySelector("[data-revert-label]")?.textContent).toContain("revision 11");
    expect(window.document.querySelector("[data-revert-title]")?.textContent).toBe("Revert Pull request mentions?");
    expect(window.document.querySelector<HTMLButtonElement>('[data-action="revert"]')?.disabled).toBe(false);
    await window.close();
  });

  test("mobile New rule keeps picker and Tide source on the new draft", async () => {
    const window = await mountPrototype("phase7-prototype-mobile.html");
    window.document.querySelector<HTMLButtonElement>('[data-action="new-rule"]')?.click();

    expect(window.document.querySelector<HTMLSelectElement>("[data-rule-picker]")?.value).toBe("new");
    expect(window.document.querySelector<HTMLTextAreaElement>("[data-rule-source]")?.value).toContain("rule new");
    expect(window.document.querySelector("[data-rule-title]")?.textContent).toBe("Untitled organization rule");
    await window.close();
  });

  for (const file of ["phase7-prototype-desktop.html", "phase7-prototype-mobile.html"]) {
    test(`${file} enforces no-access without mutating the draft`, async () => {
      const window = await mountPrototype(file);
      const scenario = window.document.querySelector<HTMLSelectElement>("[data-scenario-select]");
      const source = window.document.querySelector<HTMLTextAreaElement>("[data-rule-source]");
      const beforeTitle = window.document.querySelector("[data-rule-title]")?.textContent;
      const beforeSource = source?.value;
      if (scenario) { scenario.value = "no-access"; scenario.dispatchEvent(new window.Event("change", { bubbles: true })); }

      expect(window.document.querySelector<HTMLButtonElement>('[data-action="new-rule"]')?.disabled).toBe(true);
      expect(window.document.querySelector<HTMLButtonElement>('[data-edit-field="if"]')?.disabled).toBe(true);
      expect(source?.readOnly).toBe(true);
      window.document.querySelector<HTMLButtonElement>('[data-action="new-rule"]')?.click();
      window.document.querySelector<HTMLButtonElement>('[data-edit-field="if"]')?.click();
      if (source) { source.value = "mutated source"; source.dispatchEvent(new window.Event("input", { bubbles: true })); }
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", metaKey: true, shiftKey: true, bubbles: true }));
      expect(window.document.body.dataset.scenario).toBe("no-access");
      expect(window.document.querySelector("[data-rule-title]")?.textContent).toBe(beforeTitle);
      expect(source?.value).toBe(beforeSource);
      expect(window.document.querySelector<HTMLButtonElement>('[data-action="activate"]')?.disabled).toBe(true);
      expect(window.document.querySelector<HTMLButtonElement>('[data-action="simulate"]')?.disabled).toBe(true);
      await window.close();
    });
  }

  for (const file of ["phase7-prototype-desktop.html", "phase7-prototype-mobile.html"]) {
    test(`${file} confirms revert from the selected rule model without mixed revisions`, async () => {
      const window = await mountPrototype(file);
      if (file.includes("desktop")) {
        window.document.querySelector<HTMLButtonElement>('[data-rule-id="pulls"]')?.click();
      } else {
        const picker = window.document.querySelector<HTMLSelectElement>("[data-rule-picker]");
        if (picker) { picker.value = "pulls"; picker.dispatchEvent(new window.Event("change", { bubbles: true })); }
      }
      window.document.querySelector<HTMLButtonElement>('[data-action="revert"]')?.click();
      window.document.querySelector<HTMLButtonElement>("[data-dialog-confirm]")?.click();

      expect(window.document.querySelector("[data-revision-chip]")?.textContent).toContain("rev 13 · active");
      expect(window.document.querySelector("[data-audit-reverted]")?.textContent).toBe("Revision 13 activated · restores revision 11");
      expect(window.document.querySelector("[data-audit-revert-meta]")?.textContent).toContain("revision 12 retained");
      expect(window.document.querySelector("[data-audit-simulated]")?.textContent).toBe("Revision 12 simulated");
      expect(window.document.querySelector("[data-audit-activated]")?.textContent).toBe("Revision 12 activated");
      expect(window.document.querySelector("[data-revert-label]")?.textContent).toContain("Revert revision 13");
      expect(window.document.querySelector("[data-action-status]")?.textContent).toContain("restoring revision 11 semantics");
      expect(window.document.querySelector("[data-action-status]")?.textContent).toContain("Revision 12 remains inspectable");
      await window.close();
    });
  }

  test("desktop consecutive reverts append revisions without losing history", async () => {
    const window = await mountPrototype("phase7-prototype-desktop.html");
    window.document.querySelector<HTMLButtonElement>('[data-rule-id="pulls"]')?.click();
    for (let index = 0; index < 2; index += 1) {
      window.document.querySelector<HTMLButtonElement>('[data-action="revert"]')?.click();
      window.document.querySelector<HTMLButtonElement>("[data-dialog-confirm]")?.click();
    }

    expect(window.document.querySelector("[data-revision-chip]")?.textContent).toContain("rev 14 · active");
    expect([...window.document.querySelectorAll("[data-audit-reverted]")].map(node => node.textContent)).toEqual([
      "Revision 14 activated · restores revision 12",
      "Revision 13 activated · restores revision 11",
    ]);
    expect([...window.document.querySelectorAll("[data-audit-revert-meta]")].map(node => node.textContent)).toEqual([
      "Compensating change set cs_206 · revision 13 retained",
      "Compensating change set cs_205 · revision 12 retained",
    ]);
    expect(window.document.querySelector("[data-audit-event]")?.textContent).toBe("Revision 12 activated");
    expect(window.document.querySelector("[data-audit-simulated]")?.textContent).toBe("Revision 12 simulated");
    expect(window.document.querySelector("[data-audit-activated]")?.textContent).toBe("Revision 12 activated");
    await window.close();
  });

  for (const file of ["phase7-prototype-desktop.html", "phase7-prototype-mobile.html"]) {
    test(`${file} round-trips Tide source through rule selection`, async () => {
      const window = await mountPrototype(file);
      const source = window.document.querySelector<HTMLTextAreaElement>("[data-rule-source]");
      const custom = "rule production on thread.message_received\nwhen custom evidence\nthen Focus";
      if (source) { source.value = custom; source.dispatchEvent(new window.Event("input", { bubbles: true })); }
      if (file.includes("desktop")) {
        window.document.querySelector<HTMLButtonElement>('[data-rule-id="purchases"]')?.click();
        window.document.querySelector<HTMLButtonElement>('[data-rule-id="production"]')?.click();
      } else {
        const picker = window.document.querySelector<HTMLSelectElement>("[data-rule-picker]");
        if (picker) { picker.value = "purchases"; picker.dispatchEvent(new window.Event("change", { bubbles: true })); picker.value = "production"; picker.dispatchEvent(new window.Event("change", { bubbles: true })); }
      }
      expect(source?.value).toBe(custom);
      await window.close();
    });
  }

  test("mobile tabs implement roving keyboard selection", async () => {
    const window = await mountPrototype("phase7-prototype-mobile.html");
    const trace = window.document.querySelector<HTMLButtonElement>("#trace-tab");
    const audit = window.document.querySelector<HTMLButtonElement>("#audit-tab");

    trace?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(audit?.getAttribute("aria-selected")).toBe("true");
    expect(audit?.tabIndex).toBe(0);
    expect(window.document.querySelector<HTMLElement>("#audit-panel")?.hidden).toBe(false);
    audit?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(trace?.getAttribute("aria-selected")).toBe("true");
    expect(trace?.tabIndex).toBe(0);
    await window.close();
  });
});
