const agentBrowser = process.env.AGENT_BROWSER_PATH ?? "/opt/homebrew/bin/agent-browser";
const session = `bre-374-layout-${process.pid}`;
const port = 5187;
const url = `http://127.0.0.1:${port}/dev/inbox`;

type LayoutMetrics = {
  action: { left: number; right: number; width: number };
  actionLabel: string;
  content: { left: number; right: number; width: number };
  count: { left: number; right: number; width: number };
  documentClientWidth: number;
  documentScrollWidth: number;
  header: { left: number; right: number; width: number };
  messageRows: Array<{
    date: { left: number; right: number; width: number };
    subject: { left: number; right: number; width: number };
    subjectClipped: boolean;
    subjectText: string;
  }>;
  theme: string;
  title: { left: number; right: number; width: number };
  tools: { left: number; right: number; width: number };
};

const server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port)], {
  cwd: new URL("..", import.meta.url).pathname,
  stdout: "pipe",
  stderr: "pipe",
});

async function runBrowser(args: string[]) {
  const child = Bun.spawn([agentBrowser, "--session", session, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error([`agent-browser ${args[0]} failed (${exitCode})`, stdout, stderr].filter(Boolean).join("\n"));
  }
  return stdout.trim();
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Vite has not opened the socket yet.
    }
    await Bun.sleep(125);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const metricsExpression = `(() => {
  const required = (selector) => {
    const element = document.querySelector(selector);
    if (!element) throw new Error('Missing required element: ' + selector);
    return element;
  };
  const rectangle = (selector) => {
    const rect = required(selector).getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: rect.width };
  };
  const action = required('.selection-mode-toggle');
  const messageRows = [...document.querySelectorAll('.message-row')].map((row) => {
    const subject = row.querySelector('.message-subject-row h2');
    const date = row.querySelector('.message-meta > span:last-child');
    if (!(subject instanceof HTMLElement) || !(date instanceof HTMLElement)) {
      throw new Error('Message row is missing its subject or timestamp');
    }
    const subjectRect = subject.getBoundingClientRect();
    const dateRect = date.getBoundingClientRect();
    return {
      date: { left: dateRect.left, right: dateRect.right, width: dateRect.width },
      subject: { left: subjectRect.left, right: subjectRect.right, width: subjectRect.width },
      subjectClipped: subject.scrollWidth > subject.clientWidth,
      subjectText: subject.textContent.trim()
    };
  });
  return JSON.stringify({
    action: rectangle('.selection-mode-toggle'),
    actionLabel: action.textContent.trim(),
    content: rectangle('.desktop-workspace > .content-pane'),
    count: rectangle('.stream-title-line > span'),
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    header: rectangle('.pane-header'),
    messageRows,
    theme: document.documentElement.dataset.theme || 'light',
    title: rectangle('.stream-title-line h1'),
    tools: rectangle('.stream-header-tools')
  });
})()`;

function parseMetrics(output: string): LayoutMetrics {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  const encoded = lines.findLast((line) => line.startsWith('"{'));
  if (!encoded) throw new Error(`Could not parse layout metrics from agent-browser output:\n${output}`);
  return JSON.parse(JSON.parse(encoded)) as LayoutMetrics;
}

function assertDesktopLayout(metrics: LayoutMetrics, width: number, expectedLabel: string) {
  const contentGap = metrics.action.left - Math.max(metrics.title.right, metrics.count.right);
  const selectedRows = expectedLabel === "Done selecting" ? metrics.messageRows : [];
  const longSubject = selectedRows.find((row) => row.subjectText === "Your annual plan renews September 3");
  const failures = [
    metrics.actionLabel === expectedLabel || `expected action label ${expectedLabel}, got ${metrics.actionLabel}`,
    metrics.header.left >= metrics.content.left - 0.5 || "header begins outside content pane",
    metrics.header.right <= metrics.content.right + 0.5 || "header ends outside content pane",
    metrics.action.right <= metrics.header.right + 0.5 || "action ends outside header",
    metrics.tools.right <= metrics.header.right + 0.5 || "tools end outside header",
    contentGap >= 12 || `title/count overlaps actions (gap ${contentGap}px)`,
    metrics.documentScrollWidth <= metrics.documentClientWidth || "document has horizontal overflow",
    expectedLabel !== "Done selecting" || Boolean(longSubject) || "long Figma subject fixture is missing",
    ...selectedRows.map((row) => row.subject.right <= row.date.left - 8 || `${row.subjectText}: subject/timestamp lanes overlap by ${row.subject.right - row.date.left}px`),
  ].filter((result): result is string => result !== true);
  if (failures.length) {
    throw new Error(`${width}px ${metrics.theme} ${expectedLabel}: ${failures.join("; ")}\n${JSON.stringify(metrics, null, 2)}`);
  }
}

function assertMobileGutter(metrics: LayoutMetrics) {
  const failures = [
    Math.abs(metrics.content.width - 358) <= 0.5 || `expected 358px content width, got ${metrics.content.width}px`,
    Math.abs(metrics.content.left - 16) <= 0.5 || `expected 16px left gutter, got ${metrics.content.left}px`,
    Math.abs(390 - metrics.content.right - 16) <= 0.5 || `expected 16px right gutter, got ${390 - metrics.content.right}px`,
    metrics.documentScrollWidth <= metrics.documentClientWidth || "document has horizontal overflow",
  ].filter((result): result is string => result !== true);
  if (failures.length) throw new Error(`390px ${metrics.theme}: ${failures.join("; ")}\n${JSON.stringify(metrics, null, 2)}`);
}

async function measure() {
  return parseMetrics(await runBrowser(["eval", metricsExpression]));
}

async function clickButton(name: string) {
  await runBrowser(["find", "role", "button", "click", "--name", name, "--exact"]);
  await runBrowser(["wait", "300"]);
}

async function switchTheme(name: "Light" | "Orca Black") {
  await runBrowser(["find", "role", "button", "click", "--name", `Switch to ${name}`, "--exact"]);
  // Theme changes use a 420ms view transition; wait until its overlay releases pointer input.
  await runBrowser(["wait", "600"]);
}

try {
  await waitForServer();
  await runBrowser(["open", url]);
  await runBrowser(["wait", "700"]);

  for (const width of [1024, 1280, 1440]) {
    await runBrowser(["set", "viewport", String(width), "768"]);
    for (const theme of ["light", "dark"] as const) {
      const current = await measure();
      if (current.theme !== theme) {
        await switchTheme(theme === "dark" ? "Orca Black" : "Light");
      }
      assertDesktopLayout(await measure(), width, "Select");
      await clickButton("Select");
      assertDesktopLayout(await measure(), width, "Done selecting");
      await clickButton("Done selecting");
    }
  }

  await runBrowser(["set", "viewport", "390", "844"]);
  for (const theme of ["light", "dark"] as const) {
    const current = await measure();
    if (current.theme !== theme) {
      await switchTheme(theme === "dark" ? "Orca Black" : "Light");
    }
    assertMobileGutter(await measure());
  }

  console.log("BRE-374/BRE-376 browser layout check passed: 1024/1280/1440 Select + Done selecting with separated subject/timestamp lanes, and 390px gutters in Light + Orca Black.");
} finally {
  await runBrowser(["close"]).catch(() => undefined);
  server.kill();
  await server.exited;
}
