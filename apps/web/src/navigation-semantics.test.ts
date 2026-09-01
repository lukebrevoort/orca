import { describe, expect, test } from "bun:test";

const appStyles = await Bun.file(new URL("./styles.css", import.meta.url)).text();
const desktopStyles = await Bun.file(new URL("./desktop-switch.css", import.meta.url)).text();
const organizationStyles = await Bun.file(new URL("./organization-views.css", import.meta.url)).text();

function latestRule(source: string, selector: string) {
  const start = source.lastIndexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing CSS rule for ${selector}`);
  return source.slice(start, source.indexOf("}", start) + 1);
}

function declarationBlock(source: string, selector: string) {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing declaration block for ${selector}`);
  return source.slice(start, source.indexOf("}", start) + 1);
}

function hexToken(block: string, name: string) {
  const match = block.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i"));
  if (!match?.[1]) throw new Error(`Missing hex token ${name}`);
  return match[1];
}

function contrastRatio(foreground: string, background: string) {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
    const [red, green, blue] = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

describe("BRE-363 navigation and control semantics", () => {
  test("uses one readable semantic treatment for disabled desktop controls", () => {
    expect(desktopStyles).toContain("--desktop-control-disabled-ink:");
    expect(desktopStyles).toContain("--desktop-control-disabled-surface:");

    for (const selector of [
      ".desktop-space-row-actions button:disabled",
      ".organization-trace-trigger:disabled",
      ".tide-table footer button:disabled",
      ".rule-lifecycle > button:disabled,.rule-lifecycle .trace-revert-actions button:disabled",
      ".simulation-card button:disabled",
      ".trace-drawer button:disabled",
    ]) {
      const rule = latestRule(desktopStyles, selector);
      expect(rule).toContain("color: var(--desktop-control-disabled-ink)");
      expect(rule).toContain("background: var(--desktop-control-disabled-surface)");
      expect(rule).not.toContain("opacity:");
    }

    for (const selector of [".view-action:disabled", ".view-icon-action:disabled"]) {
      const rule = latestRule(organizationStyles, selector);
      expect(rule).toContain("color: var(--desktop-control-disabled-ink)");
      expect(rule).toContain("background: var(--desktop-control-disabled-surface)");
      expect(rule).not.toContain("opacity:");
    }
  });

  test("keeps the selected Gmail-label glyph on theme-safe surface, border, and ink tokens", () => {
    const selectedGlyph = latestRule(appStyles, ".label-migration-option-selected .label-migration-check");
    expect(selectedGlyph).toContain("background: var(--orca-surface-hover)");
    expect(selectedGlyph).toContain("border-color: var(--orca-border)");
    expect(selectedGlyph).toContain("color: var(--orca-ink)");
    expect(selectedGlyph).not.toContain("var(--orca-accent)");
    expect(selectedGlyph).not.toContain("#fff");
  });

  test("keeps disabled text at WCAG AA and selected markers above 3:1 in both themes", () => {
    for (const selector of [":root", ':root[data-theme="dark"]']) {
      const theme = declarationBlock(desktopStyles, selector);
      const disabledInk = hexToken(theme, "--desktop-control-disabled-ink");
      const disabledSurface = hexToken(theme, "--desktop-control-disabled-surface");
      const selectedMarker = hexToken(theme, "--desktop-accent");

      expect(contrastRatio(disabledInk, disabledSurface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(selectedMarker, disabledSurface)).toBeGreaterThanOrEqual(3);
    }
  });
});
