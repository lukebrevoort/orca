/**
 * Public rendered guidance contrast regression. Requires an existing, authenticated
 * scratch app/session; never starts a server, creates mail or injects product CSS.
 * Open Organization > Views before running. Default probes the current theme/size;
 * --matrix covers Light/Black at 1024x768 and 1440x900. --sample measures the actual
 * no-mail sample instead of starts (use a fresh no-mail scratch user).
 * --behavior separately checks Enter/Space starts and Skip/Escape in current theme.
 * bun apps/web/scripts/check-guidance-contrast.ts --session NAME --output DIR --keep-session
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1] ?? fallback : fallback;
const session = option("--session", "guidance-contrast");
const output = resolve(option("--output", `/tmp/guidance-contrast-${process.pid}`));
mkdirSync(output, { recursive: true });
const failures: string[] = [];
let expected: { theme: string; width: number; height: number } | undefined;
async function browser(...command: string[]) {
  const child = Bun.spawn(["/opt/homebrew/bin/agent-browser", "--session", session, ...command], { stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (status) throw new Error(`${command[0]} exited ${status}: ${stderr}\n${stdout}`);
  return stdout.trim();
}
async function evaluate<T>(expression: string): Promise<T> {
  const raw = await browser("eval", `JSON.stringify(${expression})`);
  const line = raw.split("\n").findLast(value => value.trim().startsWith('"'));
  if (!line) throw new Error(`No JSON result: ${raw}`);
  return JSON.parse(JSON.parse(line)) as T;
}
const sample = args.includes("--sample");
const selector = sample ? ".first-view-sample figcaption,.first-view-sample strong,.first-view-sample p,.first-view-sample small" : ".first-view-starts button span";
// Only read browser-computed public state. Fail closed for non-solid backgrounds,
// opacity or filters that would need a different effective-color calculation.
const measurement = `(() => {
  const rgba = value => { const parts = value.match(/[\\d.]+/g)?.map(Number); if (!parts || parts.length < 3 || !value.startsWith('rgb')) throw new Error('Unsupported color '+value); return [...parts.slice(0,3),parts[3] ?? 1]; };
  const over = (fg,bg) => fg.slice(0,3).map((v,i) => v*fg[3]+bg[i]*(1-fg[3]));
  const luminance = rgb => rgb.map(v => v/255).map(v => v<=.04045 ? v/12.92 : ((v+.055)/1.055)**2.4).reduce((sum,v,i) => sum+v*[.2126,.7152,.0722][i],0);
  return { capturedAt:new Date().toISOString(), url:location.href, theme:document.documentElement.dataset.theme || 'light', transition:document.documentElement.dataset.orcaTransition || null,
    viewport:[innerWidth,innerHeight], activeElement:document.activeElement?.outerHTML, assets:[...document.querySelectorAll('script[src],link[rel="stylesheet"]')].map(n=>n.src||n.href),
    targets:[...document.querySelectorAll(${JSON.stringify(selector)})].map(node => {
      const style=getComputedStyle(node), button=node.closest('button'), control=button||node, cs=getComputedStyle(control), r=node.getBoundingClientRect();
      const chain=[]; let ancestor=node;
      while(ancestor){ const s=getComputedStyle(ancestor); chain.push({tag:ancestor.tagName,className:ancestor.className,background:s.backgroundColor,image:s.backgroundImage,opacity:s.opacity,filter:s.filter,backdropFilter:s.backdropFilter}); ancestor=ancestor.parentElement; }
      const unsupported=chain.some(s=>s.image!=='none'||Number(s.opacity)!==1||s.filter!=='none'||s.backdropFilter!=='none');
      let background=[255,255,255]; for(const entry of [...chain].reverse()) background=over(rgba(entry.background),background);
      const foreground=over(rgba(style.color),background), a=luminance(foreground), b=luminance(background);
      const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return {text:node.textContent.trim(),foreground:style.color,effectiveBackground:background,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),fontSize:style.fontSize,fontWeight:style.fontWeight,
        hovered:control.matches(':hover'),active:control.matches(':active'),focused:document.activeElement===control,focusVisible:control.matches(':focus-visible'),outline:{style:cs.outlineStyle,width:cs.outlineWidth,offset:cs.outlineOffset,color:cs.outlineColor},
        rect:{x:r.x,y:r.y,width:r.width,height:r.height},hit:control===hit||control.contains(hit),chain,unsupported};
    })};
})()`;
type Target = { text: string; ratio: number; hovered: boolean; active: boolean; focused: boolean; focusVisible: boolean; unsupported: boolean; hit: boolean; rect: { x: number; y: number; width: number; height: number }; outline: { style: string; width: string; offset: string } };
type Metrics = { theme: string; transition: string | null; viewport: number[]; targets: Target[] };
async function capture(name: string, state: string, index?: number) {
  await browser("wait", "--fn", "!document.documentElement.hasAttribute('data-orca-transition')");
  const metrics = await evaluate<Metrics>(measurement);
  await Bun.write(`${output}/${name}.json`, JSON.stringify(metrics, null, 2));
  await browser("screenshot", `${output}/${name}.png`);
  const errors: string[] = [];
  if (metrics.targets.length !== (sample ? 4 : 2)) errors.push("expected guidance text is missing");
  if (metrics.transition) errors.push("theme transition remains active");
  if (expected && (metrics.theme !== expected.theme || metrics.viewport[0] !== expected.width || metrics.viewport[1] !== expected.height)) errors.push("rendered theme/viewport differs from requested matrix case");
  for (const [i, target] of metrics.targets.entries()) {
    if (target.unsupported) errors.push(`${i}: unsupported compositing`);
    if (target.ratio < 4.5) errors.push(`${i}: text contrast ${target.ratio} < 4.5`);
    const r = target.rect;
    if (!target.hit || r.width <= 0 || r.height <= 0 || r.x < 0 || r.y < 0 || r.x+r.width > metrics.viewport[0]! || r.y+r.height > metrics.viewport[1]!) errors.push(`${i}: text not visible/hittable`);
    if (state === "default" && !sample && (target.hovered || target.active || target.focused)) errors.push(`${i}: default state not established`);
    if (i === index) {
      if (state === "hover" && !target.hovered) errors.push(`${i}: hover not established`);
      if (state === "active" && !target.active) errors.push(`${i}: held active not established`);
      if (state === "focus" && (!target.focused || !target.focusVisible || target.outline.style === "none" || parseFloat(target.outline.width) < 2)) errors.push(`${i}: visible keyboard focus missing`);
    }
  }
  failures.push(...errors.map(error => `${name}: ${error}`));
  console.log(`${errors.length ? "FAIL" : "PASS"} ${name}: ${metrics.targets.map(t=>t.ratio).join(", ")}`);
  return metrics;
}
async function openHelp() {
  if (!await evaluate<boolean>("!!document.querySelector('.first-view-help')")) await browser("find", "role", "button", "click", "--name", "Getting started", "--exact");
  await browser("wait", "--fn", `document.querySelectorAll(${JSON.stringify(selector)}).length === ${sample ? 4 : 2}`);
}
async function closeHelp() {
  if (await evaluate<boolean>("!!document.querySelector('.first-view-help')")) {
    await browser("press", "Escape");
    await browser("wait", "--fn", "!document.querySelector('.first-view-help')");
    const returned = await evaluate<boolean>("document.activeElement?.textContent.trim() === 'Getting started'");
    if (!returned) failures.push("Escape did not restore Getting started trigger focus");
  }
}
async function moveTo(selector: string) {
  const point = await evaluate<number[]>(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.x+r.width/2,r.y+r.height/2]; })()`);
  // agent-browser's low-level mouse CLI accepts integer coordinates.
  await browser("mouse", "move", String(Math.round(point[0]!)), String(Math.round(point[1]!)));
}
async function tabTo(selector: string) {
  await browser("focus", ".first-view-guidance h2");
  for(let step=0;step<6;step++) {
    await browser("press", "Tab");
    if(await evaluate<boolean>(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`)) return;
  }
  throw new Error(`Tab did not reach ${selector}`);
}
async function states(prefix: string) {
  await openHelp();
  await browser("mouse", "move", "1", "1");
  await browser("focus", ".first-view-guidance h2");
  await capture(`${prefix}-default`, "default");
  if (sample) return;
  for (let index=0; index<2; index++) {
    const button = `.first-view-starts button:nth-child(${index+1})`;
    await moveTo(button);
    await capture(`${prefix}-${index+1}-hover`, "hover", index);
    await browser("mouse", "down");
    try { await capture(`${prefix}-${index+1}-active`, "active", index); }
    // Release inside the dialog but outside the button: the backdrop legitimately
    // dismisses on pointer release there, which would remove subsequent targets.
    finally { await moveTo(".first-view-guidance h2"); await browser("mouse", "up"); }
    // Begin at a public focusable heading and use real Tab events to reach starts.
    await tabTo(button);
    await capture(`${prefix}-${index+1}-focus`, "focus", index);
  }
}
async function behavior() {
  const record = async (name: string) => {
    await browser("wait", "--fn", "!document.documentElement.hasAttribute('data-orca-transition')");
    await Bun.write(`${output}/${name}.txt`, await browser("snapshot", "-i"));
    await Bun.write(`${output}/${name}.json`, JSON.stringify(await evaluate(`({url:location.href,theme:document.documentElement.dataset.theme,viewport:[innerWidth,innerHeight],active:document.activeElement?.outerHTML,help:!!document.querySelector('.first-view-help'),search:!!document.querySelector('.global-mail-search'),bulk:!!document.querySelector('.bulk-action-bar'),selected:[...document.querySelectorAll('.message-row[aria-pressed="true"]')].map(n=>n.getAttribute('aria-label'))})`), null, 2));
    await browser("screenshot", `${output}/${name}.png`);
  };
  await openHelp();
  await tabTo(".first-view-starts button:first-child");
  await browser("press", "Enter");
  await browser("wait", ".global-mail-search");
  if(await evaluate<boolean>("!!document.querySelector('.first-view-help')")) failures.push("Search start retained help dialog");
  await record("enter-search");
  await browser("press", "Escape");
  await browser("wait", "--fn", "!document.querySelector('.global-mail-search')");
  await record("search-escape");
  await openHelp();
  await tabTo(".first-view-starts button:nth-child(2)");
  await browser("press", "Space");
  await browser("wait", ".bulk-action-bar");
  if(!await evaluate<boolean>("new URL(location.href).searchParams.get('destination') === 'all' && !document.querySelector('.first-view-help') && document.querySelectorAll('.message-row[aria-pressed=\"true\"]').length === 0")) failures.push("Selection start did not open empty selection in All Mail");
  await record("space-selection");
  await browser("find", "role", "button", "click", "--name", "Done selecting", "--exact");
  await browser("find", "role", "button", "click", "--name", "Organization", "--exact");
  await browser("find", "role", "button", "click", "--name", "Views", "--exact");
  await openHelp();
  await tabTo(".first-view-guidance footer button");
  await browser("press", "Space");
  await browser("wait", "--fn", "!document.querySelector('.first-view-help')");
  if(!await evaluate<boolean>("document.activeElement?.textContent.trim() === 'Getting started'")) failures.push("Skip did not restore trigger focus");
  await record("space-skip");
  await openHelp();
  await closeHelp();
  await record("help-escape");
}
try {
  if (args.includes("--behavior")) await behavior();
  else if (args.includes("--matrix")) {
    for (const [width,height] of [[1024,768],[1440,900]]) {
      await closeHelp();
      await browser("set", "viewport", String(width), String(height));
      for (const theme of ["light","dark"]) {
        expected = { theme, width: width!, height: height! };
        await closeHelp();
        if (await evaluate<string>("document.documentElement.dataset.theme || 'light'") !== theme) await browser("click", ".desktop-theme-toggle");
        await browser("wait", "--fn", `document.documentElement.dataset.theme === '${theme}' && !document.documentElement.hasAttribute('data-orca-transition')`);
        await states(`${theme}-${width}`);
      }
    }
  } else await states("current");
  await closeHelp();
} catch(error) { failures.push(String(error)); console.error(error); }
finally {
  await Bun.write(`${output}/result.json`, JSON.stringify({ status:failures.length ? "FAIL" : "PASS", failures, session, sample, minimumContrast:4.5, method:"WCAG sRGB computed solid-background compositing, unrounded threshold; real pointer/keyboard pseudo-states" },null,2));
  if (!args.includes("--keep-session")) await browser("close");
}
console.log(`${failures.length ? "FAIL" : "PASS"}: ${failures.length} failures; ${output}`);
process.exitCode = failures.length ? 1 : 0;
