import { describe, expect, test } from "bun:test";

const styles = await Bun.file(new URL("./styles.css", import.meta.url)).text();

function cssRuleWithDeclaration(selector: string, declaration: string) {
  const start = styles.lastIndexOf(`${selector} { ${declaration}`);
  if (start < 0) throw new Error(`Missing CSS rule for ${selector} with ${declaration}`);
  return styles.slice(start, styles.indexOf("}", start) + 1);
}

function latestCssRule(selector: string) {
  const start = styles.lastIndexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing CSS rule for ${selector}`);
  return styles.slice(start, styles.indexOf("}", start) + 1);
}

describe("compose panel surfaces", () => {
  test("keeps every panel layer opaque without removing the backdrop blur", () => {
    expect(cssRuleWithDeclaration(".slide-panel", "background: var(--orca-paper)")).toContain("background: var(--orca-paper)");
    expect(cssRuleWithDeclaration(".panel-header", "background: var(--orca-paper)")).toContain("background: var(--orca-paper)");
    expect(cssRuleWithDeclaration(".panel-body", "background: var(--orca-paper)")).toContain("background: var(--orca-paper)");
    expect(styles).toContain("backdrop-filter: blur(2px) saturate(.92)");
  });
});

describe("Zen canvas surface", () => {
  test("uses the sand palette with a restrained flow while keeping writing ink themed", () => {
    const zenCanvas = latestCssRule(".zen-canvas");
    expect(zenCanvas).toContain("background-color: var(--color-sand)");
    expect(zenCanvas).toContain("radial-gradient(ellipse at 0% 0%, color-mix(in srgb, var(--orca-accent) 13%, transparent), transparent 54%)");
    expect(zenCanvas).toContain("radial-gradient(ellipse at 100% 100%, color-mix(in srgb, var(--orca-paper) 65%, transparent), transparent 56%)");
    expect(zenCanvas).toContain("var(--color-sand)");
    expect(zenCanvas).toContain("color: var(--orca-ink)");
  });
});

describe("long message subjects", () => {
  test("reserves the action rail and gives narrow rows a separate affordance band", () => {
    expect(styles).toContain("/* BRE-258: keep long subjects inside the message content area");
    expect(styles).toContain(".message-subject-row h2");
    expect(styles).toContain("padding-right: 340px;");
    expect(styles).toContain("padding-bottom: 54px;");
    expect(styles).toContain("@media (max-width: 360px)");
  });
});

describe("profile avatar controls", () => {
  test("keeps the rail clean and the settings picker theme-safe", () => {
    expect(styles).toContain(".profile-avatar-image { display: block; height: 100%; object-fit: cover; width: 100%; }");
    expect(styles).toContain(".settings-profile-photo-change:hover,");
    expect(styles).toContain("background: var(--orca-surface-hover); border-color: var(--orca-border); color: var(--orca-ink);");
    expect(styles).not.toContain(".wave-rail-account-change");
    expect(styles).toContain(".wave-rail-account-wrap { display: none; }");
  });
});

describe("Calendar consent controls", () => {
  test("keeps selection, focus, disabled, and motion states theme-safe", () => {
    expect(styles).toContain('.calendar-selection-list > label[data-selected="true"] { background: var(--orca-surface-hover); border-color: var(--orca-border);');
    expect(styles).toContain('.calendar-day-choices button[aria-pressed="true"] { background: var(--orca-surface-hover); border-color: var(--orca-border);');
    expect(styles).toContain(".calendar-selection-list input:focus-visible + .calendar-check { outline: 2px solid var(--orca-accent);");
    expect(styles).toContain(".calendar-primary-action:disabled, .calendar-secondary-action:disabled, .calendar-day-choices button:disabled { background: var(--orca-control); color: var(--orca-muted);");
    expect(styles).toContain("@keyframes calendar-reveal-up");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
