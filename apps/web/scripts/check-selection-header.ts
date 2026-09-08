/**
 * Real-browser regression for the desktop selection/header public seam.
 * Requires an already running scratch reviewer app (scripts/bre-387-review.ts)
 * and agent-browser. Does not start/rebuild a server or alter fixture data.
 *
 * Current-state red probe (preserves the handed-off session):
 * bun apps/web/scripts/check-selection-header.ts --session NAME --keep-session --output /tmp/selection-red
 * Full matrix against an authenticated scratch session:
 * bun apps/web/scripts/check-selection-header.ts --session NAME --matrix --output /tmp/selection-green
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1] ?? fallback;
};
const session = option("--session", `selection-header-${process.pid}`);
const output = resolve(option("--output", `/tmp/orca-selection-header-${process.pid}`));
const binary = "/opt/homebrew/bin/agent-browser";
mkdirSync(output, { recursive: true });

async function browser(...command: string[]) {
  const child = Bun.spawn([binary, "--session", session, ...command], { stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (status) throw new Error(`agent-browser ${command[0]} exited ${status}: ${stderr}\n${stdout}`);
  return stdout.trim();
}

async function evaluate<T>(expression: string): Promise<T> {
  const raw = await browser("eval", `JSON.stringify(${expression})`);
  const encoded = raw.split("\n").findLast(line => line.trim().startsWith('"'));
  if (!encoded) throw new Error(`Missing JSON result: ${raw}`);
  return JSON.parse(JSON.parse(encoded)) as T;
}

// Read real layout/hit targets; never fake DOM rectangles or inject styles.
const measurement = `(() => {
  const need = (selector) => {
    const node = document.querySelector(selector);
    if (!node) throw new Error('Missing ' + selector);
    return node;
  };
  const rect = node => {
    const r = node.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
  };
  const workspace = need('.desktop-workspace');
  const pane = need('.desktop-workspace > .content-pane');
  const header = need('.desktop-workspace-header');
  const toolbar = need('.bulk-action-bar');
  const controls = [need('.desktop-global-search input'), need('.desktop-theme-toggle'), ...toolbar.querySelectorAll('button')];
  return {
    capturedAt: new Date().toISOString(), url: location.href, theme: document.documentElement.dataset.theme || 'light',
    transition: document.documentElement.dataset.orcaTransition || null,
    viewport: { width: innerWidth, height: innerHeight }, header: rect(header), toolbar: rect(toolbar),
    selected: [...document.querySelectorAll('.message-row[aria-pressed="true"]')].map(node => node.getAttribute('aria-label')).sort(),
    mixedAccount: toolbar.innerText.includes('Choose messages from one account'),
    scroll: { workspace: workspace.scrollTop, pane: pane.scrollTop, document: window.scrollY },
    ancestors: [toolbar, ...(() => { const nodes = []; let node = toolbar.parentElement; while(node) { nodes.push(node); node = node.parentElement; } return nodes; })()].map(node => {
      const s = getComputedStyle(node);
      return { node: node.className || node.tagName, overflowX: s.overflowX, overflowY: s.overflowY, maxHeight: s.maxHeight, position: s.position, top: s.top, zIndex: s.zIndex, scrollTop: node.scrollTop, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight };
    }),
    controls: controls.map(node => {
      const r = rect(node);
      const points = [[.5,.5],[.15,.5],[.85,.5],[.5,.15],[.5,.85]];
      return { label: node.getAttribute('aria-label') || node.textContent.trim(), disabled: node.disabled, rect: r,
        hits: points.map(([x,y]) => { const hit = document.elementFromPoint(r.left + r.width*x, r.top + r.height*y); return { correct: hit === node || node.contains(hit), actual: hit?.getAttribute('aria-label') || hit?.className || hit?.tagName || null }; }) };
    }),
    assets: [...document.querySelectorAll('script[src],link[rel="stylesheet"]')].map(node => node.src || node.href),
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
  };
})()`;

type Metrics = {
  theme: string; viewport: { width: number; height: number };
  header: { top: number; bottom: number }; toolbar: { top: number; bottom: number };
  selected: string[]; mixedAccount: boolean; horizontalOverflow: boolean;
  scroll: { workspace: number; pane: number; document: number };
  controls: Array<{ label: string; disabled: boolean; rect: { top: number; bottom: number; left: number; right: number; width: number; height: number }; hits: Array<{ correct: boolean; actual: string | null }> }>;
};
const failures: string[] = [];
async function capture(name: string, expectedSelection?: number) {
  // A View Transition owns pointer input until its finished promise settles.
  // Wait for the app's completion signal, never assume a fixed animation delay.
  await browser("wait", "--fn", "!document.documentElement.hasAttribute('data-orca-transition')");
  const metrics = await evaluate<Metrics>(measurement);
  await Bun.write(`${output}/${name}.json`, JSON.stringify(metrics, null, 2));
  await browser("screenshot", `${output}/${name}.png`);
  const errors: string[] = [];
  if (metrics.header.top < -0.5 || metrics.header.bottom > metrics.viewport.height) errors.push("header outside viewport");
  if (metrics.toolbar.top < metrics.header.bottom) errors.push(`toolbar overlaps header: ${metrics.toolbar.top} < ${metrics.header.bottom}`);
  if (metrics.toolbar.bottom > metrics.viewport.height) errors.push("toolbar extends below viewport");
  if (metrics.scroll.workspace < 100) errors.push("fixture is not scrolled (cannot exercise sticky collision)");
  if (metrics.horizontalOverflow) errors.push("document horizontal overflow");
  if (expectedSelection !== undefined && metrics.selected.length !== expectedSelection) errors.push(`expected ${expectedSelection} selected rows, got ${metrics.selected.length}`);
  if (expectedSelection === 2 && !metrics.mixedAccount) errors.push("fixture does not span two accounts");
  for (const control of metrics.controls) {
    const r = control.rect;
    if (!r.width || !r.height || r.left < 0 || r.right > metrics.viewport.width || r.top < 0 || r.bottom > metrics.viewport.height) errors.push(`${control.label}: control outside viewport`);
    if (control.hits.some(hit => !hit.correct)) errors.push(`${control.label}: wrong pointer target ${JSON.stringify(control.hits)}`);
  }
  failures.push(...errors.map(error => `${name}: ${error}`));
  console.log(`${errors.length ? "FAIL" : "PASS"} ${name}: header ${metrics.header.bottom}, toolbar ${metrics.toolbar.top}..${metrics.toolbar.bottom}, scroll ${metrics.scroll.workspace}`);
  return metrics;
}

async function scroll(top: number) {
  await browser("eval", `document.querySelector('.desktop-workspace').scrollTo({top:${top},behavior:'instant'})`);
  await browser("wait", "100");
}
async function click(name: string) {
  await browser("find", "role", "button", "click", "--name", name, "--exact");
}
async function keyboardFocus(name: string) {
  // Enter controls with Tab so :focus-visible is exercised, not simulated.
  for (const [selector, predecessor] of [
    [".desktop-theme-toggle", ".desktop-global-search input"],
    [".bulk-select-all", ".bulk-select-all"],
  ]) {
    await browser("focus", predecessor!);
    if (selector === predecessor) await browser("press", "Shift+Tab");
    await browser("press", "Tab");
    const focus = await evaluate<{ correct: boolean; visible: boolean; outline: string; width: number; offset: number }>(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)}), style = getComputedStyle(node);
      return { correct: document.activeElement === node, visible: node.matches(':focus-visible'), outline: style.outlineStyle, width: parseFloat(style.outlineWidth), offset: parseFloat(style.outlineOffset) };
    })()`);
    if (!focus.correct || !focus.visible || focus.outline === "none" || focus.width < 2 || focus.offset < 2) failures.push(`${name}: missing keyboard focus on ${selector}: ${JSON.stringify(focus)}`);
    await browser("screenshot", `${output}/${name}-${selector === ".desktop-theme-toggle" ? "theme" : "bulk"}-focus.png`);
    await Bun.write(`${output}/${name}-${selector === ".desktop-theme-toggle" ? "theme" : "bulk"}-focus.json`, JSON.stringify(focus, null, 2));
  }
}
async function themeClickPreservesSelection(name: string, before: Metrics) {
  const startedAt = Date.now();
  await click(before.theme === "dark" ? "Switch to Light" : "Switch to Orca Black");
  await browser("wait", "--fn", `document.documentElement.dataset.theme === '${before.theme === "dark" ? "light" : "dark"}' && !document.documentElement.hasAttribute('data-orca-transition')`);
  await Bun.write(`${output}/${name}-timing.json`, JSON.stringify({ startedAt: new Date(startedAt).toISOString(), settledAt: new Date().toISOString(), clickAndWaitElapsedMs: Date.now() - startedAt, condition: "expected theme applied and data-orca-transition removed by transition.finished" }, null, 2));
  const after = await capture(name, before.selected.length);
  if (after.theme === before.theme) failures.push(`${name}: theme did not change`);
  if (JSON.stringify(after.selected) !== JSON.stringify(before.selected)) failures.push(`${name}: theme changed selected rows`);
  if (Math.abs(after.scroll.workspace - before.scroll.workspace) > 1) failures.push(`${name}: theme changed source scroll`);
  await keyboardFocus(name);
}
async function searchReturn(name: string) {
  await scroll(600);
  const before = await evaluate<Metrics>(measurement);
  await browser("fill", ".desktop-global-search input", "Apartment");
  await browser("press", "Enter");
  await browser("wait", ".global-mail-search");
  await browser("screenshot", `${output}/${name}-search.png`);
  await browser("press", "Escape");
  await browser("wait", "--fn", "!document.querySelector('.global-mail-search')");
  const after = await capture(`${name}-search-return`, before.selected.length);
  if (JSON.stringify(after.selected) !== JSON.stringify(before.selected)) failures.push(`${name}: Search return changed selected fixture rows`);
  if (Math.abs(after.scroll.workspace - before.scroll.workspace) > 1) failures.push(`${name}: Search return changed source scroll`);
}

try {
  if (args.includes("--matrix")) {
    for (const [width, height] of [[1024,768],[1440,900]]) {
      await browser("set", "viewport", String(width), String(height));
      await scroll(0);
      // Use only visible app controls. The authenticated scratch fixture supplies these rows.
      const selecting = await evaluate<boolean>(`Boolean(document.querySelector('.bulk-action-bar'))`);
      if (selecting) await click("Done selecting");
      await click("Select");
      await scroll(600);
      const empty = await capture(`${width}-empty`, 0);
      await themeClickPreservesSelection(`${width}-empty-theme`, empty);
      await scroll(0);
      await click("Select Maya Chen: Apartment viewing 1");
      await click("Select Maya Chen: Apartment weekend");
      // Preserve the natural click auto-scroll in its own artifact before deterministic deep scrolling.
      await Bun.write(`${output}/${width}-mixed-autoscroll.json`, JSON.stringify(await evaluate(measurement), null, 2));
      await scroll(600);
      const mixed = await capture(`${width}-mixed`, 2);
      await searchReturn(`${width}-mixed-${mixed.theme}`);
      await themeClickPreservesSelection(`${width}-mixed-theme`, mixed);
      await searchReturn(`${width}-mixed-${mixed.theme === "dark" ? "light" : "dark"}`);
      await scroll(1200);
      const deep = await capture(`${width}-mixed-deep`, 2);
      await themeClickPreservesSelection(`${width}-mixed-deep-theme`, deep);
    }
  } else {
    await capture("current");
  }
  await Bun.write(`${output}/result.json`, JSON.stringify({ status: failures.length ? "fail" : "pass", failures }, null, 2));
  if (failures.length) throw new Error(failures.join("\n"));
  console.log(`Selection/header regression passed. Artifacts: ${output}`);
} finally {
  if (!args.includes("--keep-session")) await browser("close");
}
