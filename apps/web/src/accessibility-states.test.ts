import { describe, expect, test } from "bun:test";

const desktopStyles = await Bun.file(new URL("./desktop-switch.css", import.meta.url)).text();
const organizationLaneStyles = await Bun.file(new URL("./organization-lanes.css", import.meta.url)).text();
const organizationStyles = await Bun.file(new URL("./organization-views.css", import.meta.url)).text();
const styles = await Bun.file(new URL("./styles.css", import.meta.url)).text();

function cssRule(source: string, selector: string) {
  const start = source.lastIndexOf(selector);
  if (start < 0) throw new Error(`Missing CSS selector: ${selector}`);
  const end = source.indexOf("}", start);
  if (end < 0) throw new Error(`Unclosed CSS selector: ${selector}`);
  return source.slice(start, end + 1);
}

function luminance(hex: string) {
  const channels = hex.match(/[a-f\d]{2}/gi)?.map((channel) => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  if (!channels || channels.length !== 3) throw new Error(`Expected six-digit color: ${hex}`);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(left: string, right: string) {
  const lighter = Math.max(luminance(left), luminance(right));
  const darker = Math.min(luminance(left), luminance(right));
  return (lighter + 0.05) / (darker + 0.05);
}

function paletteFor(theme: "light" | "dark") {
  const values = new Map<string, string>();
  const collect = (source: string, pattern: RegExp) => {
    for (const block of source.matchAll(pattern)) {
      for (const declaration of block[1]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
        values.set(declaration[1]!, declaration[2]!.trim());
      }
    }
  };
  const rootPattern = /^:root\s*\{([^}]*)\}/gm;
  const darkRootPattern = /^:root\[data-theme="dark"\]\s*\{([^}]*)\}/gm;
  collect(styles, rootPattern);
  collect(desktopStyles, rootPattern);
  if (theme === "dark") {
    collect(styles, darkRootPattern);
    collect(desktopStyles, darkRootPattern);
  }

  const resolve = (name: string, seen = new Set<string>()): string => {
    if (seen.has(name)) throw new Error(`Circular color token: ${name}`);
    const value = values.get(name);
    if (!value) throw new Error(`Missing color token: ${name}`);
    const alias = value.match(/^var\((--[\w-]+)\)$/);
    if (!alias) return value;
    return resolve(alias[1]!, new Set([...seen, name]));
  };
  return { resolve };
}

describe("theme-safe semantic control states", () => {
  test("uses selected and disabled tokens instead of compounding muted colors with opacity", () => {
    expect(desktopStyles).toContain("--desktop-control-selected-background: var(--desktop-surface-hover);");
    expect(desktopStyles).toContain("--desktop-control-disabled-ink: var(--desktop-muted);");

    const desktopDisabledSelectors = [
      ".desktop-space-row-actions button:disabled",
      ".organization-trace-trigger:disabled",
      ".tide-table footer button:disabled",
      ".rule-lifecycle > button:disabled,.rule-lifecycle .trace-revert-actions button:disabled",
      ".simulation-card button:disabled",
      ".trace-drawer button:disabled",
    ];
    for (const selector of desktopDisabledSelectors) {
      const rule = cssRule(desktopStyles, selector);
      expect(rule).toContain("var(--desktop-control-disabled-ink)");
      expect(rule).not.toContain("opacity:");
    }
    for (const selector of [".view-action:disabled", ".view-icon-action:disabled"]) {
      const rule = cssRule(organizationStyles, selector);
      expect(rule).toContain("var(--desktop-control-disabled-ink)");
      expect(rule).not.toContain("opacity:");
    }
    expect(organizationLaneStyles).toContain("background:var(--desktop-control-disabled-background)");
    expect(organizationLaneStyles).toContain("color:var(--desktop-control-disabled-ink)");
    expect(organizationLaneStyles).not.toMatch(/:disabled\s*\{[^}]*opacity:\s*\.(?:\d+)/s);
    const labelImportDisabled = cssRule(styles, ".label-migration-actions button:disabled");
    expect(labelImportDisabled).toContain("var(--orca-control-disabled-ink)");
    expect(labelImportDisabled).toContain("opacity: 1");
  });

  test("keeps the Gmail selected glyph on the shared surface, border, and ink treatment", () => {
    expect(styles).toContain("--orca-control-selected-background: var(--orca-surface-hover);");
    const rule = cssRule(styles, ".label-migration-option-selected .label-migration-check");
    expect(rule).toContain("background: var(--orca-control-selected-background)");
    expect(rule).toContain("border-color: var(--orca-control-selected-border)");
    expect(rule).toContain("color: var(--orca-control-selected-ink)");
    expect(rule).not.toContain("color: #fff");
  });

  test("keeps the bulk selection control readable when pressed or busy", () => {
    const selected = cssRule(styles, '.bulk-action-bar .bulk-select-all[aria-pressed="true"]');
    expect(selected).toContain("background: var(--orca-control-selected-background)");
    expect(selected).toContain("color: var(--orca-control-selected-ink)");
    expect(selected).toContain("box-shadow: inset 0 -2px var(--orca-control-selected-indicator)");
    const disabled = cssRule(styles, ".bulk-action-bar button:disabled");
    expect(disabled).toContain("color: var(--orca-control-disabled-ink)");
    expect(disabled).toContain("opacity: 1");
    expect(cssRule(styles, ".bulk-action-bar button:focus-visible")).toContain("outline: 2px solid var(--orca-control-selected-indicator)");
    expect(cssRule(styles, ".message-row-wrap-selected .message-row")).toContain("box-shadow: inset 3px 0 var(--orca-control-selected-indicator)");
    expect(cssRule(styles, '.message-row[aria-pressed="true"] .message-select-indicator')).toContain("box-shadow: 0 0 0 2px var(--orca-control-selected-indicator)");
  });

  test("keeps text at AA and visible state indicators above three-to-one in both themes", () => {
    for (const name of ["light", "dark"] as const) {
      const palette = paletteFor(name);
      const surface = palette.resolve("--orca-control-selected-background");
      expect(contrast(palette.resolve("--orca-control-disabled-ink"), palette.resolve("--orca-control-disabled-background"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette.resolve("--orca-control-selected-ink"), surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette.resolve("--orca-control-selected-indicator"), surface)).toBeGreaterThanOrEqual(3.5);
    }
  });
});
