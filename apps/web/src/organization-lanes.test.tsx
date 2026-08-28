import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { OrganizationLaneWorkspace, ThreadLaneControls } from "./organization-lanes";

const styles = await Bun.file(new URL("./organization-lanes.css", import.meta.url)).text();

describe("BRE-311 Organization Lane UI", () => {
  test("renders stable Lane management and every policy default without provider deletion", () => {
    const html = renderToStaticMarkup(<OrganizationLaneWorkspace demoMode />);
    expect(html).toContain("Lanes set the current");
    expect(html).toContain("Workspace Fallback");
    expect(html).toContain("Default Lane Policy");
    expect(html).toContain("Visibility");
    expect(html).toContain("Interruption");
    expect(html).toContain("Review");
    expect(html).toContain("Retention");
    expect(html).toContain("deletion authority is always false");
    expect(html).toContain('aria-pressed="true"');
  });

  test("renders readable Thread Manual Override and evidence triggers", () => {
    const html = renderToStaticMarkup(<ThreadLaneControls accountId="account_a" demoMode threadId="thread_a" />);
    expect(html).toContain("Everything else");
    expect(html).toContain("Why is this here?");
    expect(html).toContain("Lane");
  });

  test("uses the theme-safe surface, border, and ink treatment for selected and pressed controls", () => {
    expect(styles).toContain('.lane-card-actions button[aria-pressed="true"]');
    expect(styles).toContain("background:var(--desktop-surface-hover)");
    expect(styles).toContain("border-color:var(--desktop-border-strong)");
    expect(styles).toContain("color:var(--desktop-ink)");
    expect(styles).toContain(':root[data-theme="dark"] .lane-card-selected');
  });
});
