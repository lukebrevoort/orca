import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { OrganizationViewsWorkspace } from "./organization-views";

const styles = await Bun.file(new URL("./organization-views.css", import.meta.url)).text();

describe("BRE-313 Organization Views UI", () => {
  test("renders an accepted live Views surface with a cross-Lane weekly review", () => {
    const html = renderToStaticMarkup(<OrganizationViewsWorkspace demoMode />);
    expect(html).toContain("Live Views");
    expect(html).toContain("Weekly production review");
    expect(html).toContain("Unresolved production failure");
    expect(html).toContain("Everything else");
    expect(html).toContain("2 accounts");
    expect(html).toContain("Live from current Thread organization");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Load more");
  });

  test("keeps default, hover, focus, selected, and disabled controls readable in both themes", () => {
    expect(styles).toContain(".view-chip:hover");
    expect(styles).toContain(".view-chip:focus-visible");
    expect(styles).toContain('.view-chip[aria-pressed="true"]');
    expect(styles).toContain("background: var(--desktop-surface-hover)");
    expect(styles).toContain("border-color: var(--desktop-border-strong)");
    expect(styles).toContain("color: var(--desktop-ink)");
    expect(styles).toContain(".view-action:disabled");
    expect(styles).toContain(':root[data-theme="dark"] .views-workspace');
  });
});
