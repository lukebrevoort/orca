import { describe, expect, test } from "bun:test";

const styles = await Bun.file(new URL("./styles.css", import.meta.url)).text();

function cssRuleWithDeclaration(selector: string, declaration: string) {
  const start = styles.lastIndexOf(`${selector} { ${declaration}`);
  if (start < 0) throw new Error(`Missing CSS rule for ${selector} with ${declaration}`);
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
