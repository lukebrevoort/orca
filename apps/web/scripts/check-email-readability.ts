import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

// Real Chromium layout checks: happy-dom does not resolve inherited CSS sizes.
const browser = process.env.AGENT_BROWSER_PATH ?? "/opt/homebrew/bin/agent-browser";
const session = `bre-379-reader-${process.pid}`;
const evidence = process.env.EVIDENCE_DIR ?? "/tmp/orca-bre-379";
const fixture = await Bun.file(new URL("fixtures/nested-newsletter.html", import.meta.url)).text();
const css = (await Bun.file(new URL("../src/styles.css", import.meta.url)).text()).replace(/^@import.*$/gm, "");
const desktopCss = await Bun.file(new URL("../src/desktop-switch.css", import.meta.url)).text();
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
  if (path === "/desktop.css") return new Response(desktopCss, { headers: { "Content-Type": "text/css" } });
  if (path === "/newsletter-banner.svg") return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200"><rect width="600" height="200" fill="#b5c7aa"/><circle cx="300" cy="100" r="65" fill="#e4b646"/><circle cx="320" cy="80" r="9" fill="#222"/></svg>', { headers: { "Content-Type": "image/svg+xml" } });
  return new Response(`<!doctype html><html data-theme="light"><head><meta charset="utf-8"><title>BRE-379 · Newsletter readability</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/desktop.css"><style>body{margin:0;background:var(--orca-paper);color:var(--orca-ink)}main{margin:32px 32px 32px 300px;max-width:760px;padding:24px;background:var(--orca-canvas)}.reader-body{max-width:100%}</style></head><body><main><header><p>ORCA · READER REGRESSION FIXTURE</p><h2>Newsletter reading</h2><p id="state"></p></header><div class="reader-body reader-body-html">${fixture}</div></main></body></html>`, { headers: { "Content-Type": "text/html" } });
}});
async function run(...args: string[]) {
  const child = Bun.spawn([browser, "--session", session, ...args], { stdout: "pipe", stderr: "pipe" });
  const [exit, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exit) throw new Error(`${args[0]}: ${out}\n${error}`);
  return out.trim();
}
try {
  await mkdir(evidence, { recursive: true });
  await run("open", `http://127.0.0.1:${server.port}`);
  for (const width of [1440, 1024]) for (const theme of ["light", "dark"]) for (const size of ["standard", "large"]) {
    await run("set", "viewport", String(width), "1000");
    await run("eval", `document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.dataset.readerSize=${JSON.stringify(size)};document.querySelector('#state').textContent=${JSON.stringify(`${width}px · ${theme} · ${size}`)}`);
    const raw = await run("eval", `JSON.stringify((() => {
      const root = document.querySelector('.reader-body');
      const img = root.querySelector('img');
      return {base:parseFloat(getComputedStyle(root).fontSize),copy:[...root.querySelectorAll('[data-probe="body"]')].map(el=>parseFloat(getComputedStyle(el).fontSize)),authored:parseFloat(getComputedStyle(root.querySelector('[data-probe="authored"]')).fontSize),imageWidth:img.getBoundingClientRect().width,imageHeight:img.getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>innerWidth,tables:root.querySelectorAll('table').length};
    })())`);
    let metrics = JSON.parse(raw);
    if (typeof metrics === "string") metrics = JSON.parse(metrics);
    await run("screenshot", `${evidence}/${width}-${theme}-${size}.png`);
    console.log(`${width} ${theme} ${size}`, metrics);
    assert.equal(metrics.base, size === "large" ? 20 : 18);
    for (const font of metrics.copy) assert.equal(font, metrics.base, "Nested layout tables must not compound font reduction");
    assert.equal(metrics.authored, 16, "Preserve authored type sizes");
    assert.equal(metrics.tables, 6, "Preserve newsletter layout");
    assert.ok(Math.abs(metrics.imageWidth / metrics.imageHeight - 3) < .01, "Preserve image aspect ratio");
    assert.equal(metrics.overflow, false, "Fixed-width newsletter must fit narrow desktop");
  }
} finally {
  await run("close");
  server.stop(true);
}
