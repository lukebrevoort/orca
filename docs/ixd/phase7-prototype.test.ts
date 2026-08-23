import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";

const ixdRoot = import.meta.dir;

function readPrototype(name: string) {
  return readFileSync(join(ixdRoot, name), "utf8");
}

async function mountPrototype(name: string) {
  const html = readPrototype(name);
  const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  const window = new Window({
    url: "http://localhost/organization",
    settings: { disableJavaScriptEvaluation: false },
  });
  window.document.write(html.replace(/<script>[\s\S]*?<\/script>/, ""));
  Function("window", "document", inlineScript)(window, window.document);
  await window.happyDOM.waitUntilComplete();
  return window;
}

describe("BRE-307 Organization prototypes", () => {
  for (const file of ["phase7-prototype-desktop.html", "phase7-prototype-mobile.html"]) {
    test(`${file} preserves the accepted Organization direction`, () => {
      const html = readPrototype(file);

      expect(html).toContain("Glass Box");
      expect(html).toContain("Tide Table");
      expect(html).toContain("Simulate");
      expect(html).toContain("Activate");
      expect(html).toContain("Trace");
      expect(html).toContain("Audit history");
      expect(html).toContain("Revert");
      expect(html).toContain('data-theme="light"');
      expect(html).toContain('data-scenario="default"');
    });

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

      expect(window.document.querySelector("[data-revision-chip]")?.textContent).toContain("rev 11 · draft · simulated");
      expect(window.document.querySelector("[data-audit-event]")?.textContent).toBe("Revision 11 simulated");
      expect(window.document.querySelector("[data-audit-simulated]")?.textContent).toBe("Revision 11 simulated");
      expect(window.document.querySelector("[data-audit-activated]")?.textContent).toBe("Revision 11 activated");
      expect(window.document.querySelector("[data-revert-label]")?.textContent).toContain("revision 10");
      expect(window.document.querySelector("[data-action-status]")?.textContent).toContain("Reverted revision 12");
      expect(window.document.querySelector("[data-action-status]")?.textContent).toContain("Revision 11 is ready to inspect");
      await window.close();
    });
  }

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
