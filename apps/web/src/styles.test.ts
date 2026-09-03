import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const styles = await Bun.file(new URL("./styles.css", import.meta.url)).text();
const desktopStyles = await Bun.file(new URL("./desktop-switch.css", import.meta.url)).text();
const organizationLaneStyles = await Bun.file(new URL("./organization-lanes.css", import.meta.url)).text();

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

function mediaBlock(query: string) {
  const marker = `@media ${query} {`;
  const start = styles.indexOf(marker);
  if (start < 0) throw new Error(`Missing media block for ${query}`);
  let depth = 0;
  for (let index = styles.indexOf("{", start); index < styles.length; index += 1) {
    if (styles[index] === "{") depth += 1;
    if (styles[index] === "}") depth -= 1;
    if (depth === 0) return styles.slice(start, index + 1);
  }
  throw new Error(`Unclosed media block for ${query}`);
}

function responsiveSignalStyles(width: number) {
  const browser = new Window({ height: 568, width });
  const sheet = browser.document.createElement("style");
  sheet.textContent = styles;
  browser.document.head.append(sheet);

  const pane = browser.document.createElement("section");
  pane.className = "content-pane";
  const reader = browser.document.createElement("section");
  reader.className = "content-pane content-pane-reader";
  const mute = browser.document.createElement("details");
  mute.className = "agent-event-mute-menu";
  const summary = browser.document.createElement("summary");
  const menu = browser.document.createElement("div");
  mute.append(summary, menu);
  browser.document.body.append(pane, reader, mute);

  const paneStyle = browser.getComputedStyle(pane);
  const readerStyle = browser.getComputedStyle(reader);
  const muteStyle = browser.getComputedStyle(mute);
  const menuStyle = browser.getComputedStyle(menu);
  const result = {
    menu: { flex: muteStyle.flex, left: menuStyle.left, minWidth: muteStyle.minWidth, right: menuStyle.right, width: menuStyle.width },
    pane: { height: paneStyle.height, minHeight: paneStyle.minHeight, overflowY: paneStyle.overflowY },
    reader: { height: readerStyle.height, minHeight: readerStyle.minHeight, overflowY: readerStyle.overflowY },
  };
  browser.close();
  return result;
}

describe("compose panel surfaces", () => {
  test("keeps every panel layer opaque without removing the backdrop blur", () => {
    expect(cssRuleWithDeclaration(".slide-panel", "background: var(--orca-paper)")).toContain("background: var(--orca-paper)");
    expect(cssRuleWithDeclaration(".panel-header", "background: var(--orca-paper)")).toContain("background: var(--orca-paper)");
    expect(cssRuleWithDeclaration(".panel-body", "background: var(--orca-paper)")).toContain("background: var(--orca-paper)");
    expect(styles).toContain("backdrop-filter: blur(2px) saturate(.92)");
  });

  test("keeps blocked delivery and invalid message states labeled in both themes", () => {
    expect(styles).toContain("/* BRE-356: validation stays readable in both semantic theme palettes. */");
    expect(styles).toContain('.compose-writing-area[aria-invalid="true"] { box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--orca-danger) 72%, var(--orca-border)); }');
    expect(styles).toContain('.compose-send[aria-disabled="true"], .compose-send[aria-disabled="true"]:not(:disabled) { background: var(--orca-surface-hover); border-color: var(--orca-border); color: var(--orca-ink);');
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

describe("M8 desktop presentation regressions", () => {
  test("gives Later its own non-overlapping action rail", () => {
    expect(desktopStyles).toContain(".desktop-shell .inbox-view-later .message-row { padding-right: 430px; }");
    expect(desktopStyles).toContain(".desktop-shell .inbox-view-later .message-evidence-button { right: 298px;");
    expect(desktopStyles).toContain(".desktop-shell .inbox-view-later .message-row-wrap > .sender-attention-control { right: 254px;");
    expect(desktopStyles).toContain(".desktop-shell .inbox-view-later .later-row-actions { right: 12px;");
    expect(desktopStyles).toContain("width: 230px;");
    expect(desktopStyles).toContain("@media (max-width: 1100px) and (min-width: 761px)");
  });

  test("keeps the reader return control inside the reader surface", () => {
    expect(desktopStyles).toContain(".desktop-shell .message-reader { position: relative; }");
    expect(desktopStyles).toContain(".desktop-shell .reader-nav { left: 28px; position: absolute; top: 28px;");
  });

  test("uses a light theme scrim and preserves a darker Black scrim", () => {
    expect(organizationLaneStyles).toContain("background: color-mix(in srgb, var(--desktop-paper) 72%, transparent);");
    expect(organizationLaneStyles).toContain(':root[data-theme="dark"] .thread-lane-backdrop { background: rgba(0, 0, 0, .56); }');
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

describe("OAuth login layout and provider states", () => {
  test("reserves a brand row and keeps unavailable controls readable in both themes", () => {
    expect(cssRuleWithDeclaration(".oauth-shell", "display: grid; gap: 28px 92px")).toContain('grid-template-areas: "brand brand" "hero setup"');
    expect(cssRuleWithDeclaration(".oauth-brand", "align-self: start")).toContain("grid-area: brand");
    expect(cssRuleWithDeclaration(".oauth-brand", "align-self: start")).toContain("position: static");
    expect(latestCssRule(".oauth-hero .oauth-eyebrow")).toContain("position: static");
    const disabled = latestCssRule(".oauth-provider-button:disabled, .oauth-google-button:disabled, .oauth-outlook-button:disabled");
    expect(disabled).toContain("background: var(--orca-surface-hover)");
    expect(disabled).toContain("border-color: var(--orca-border)");
    expect(disabled).toContain("color: var(--orca-muted)");
    expect(disabled).toContain("opacity: 1");
    const retryDisabled = latestCssRule(".oauth-retry-button:disabled");
    expect(retryDisabled).toContain("background: var(--orca-surface-hover)");
    expect(retryDisabled).toContain("color: var(--orca-muted)");
    expect(retryDisabled).toContain("cursor: not-allowed");
    expect(styles).toContain(".oauth-google-button:focus-visible");
    expect(styles).toContain("outline: 2px solid var(--orca-accent)");
  });
});

describe("primary mobile navigation", () => {
  test("keeps Drafts selected states theme-safe and moves local feedback clear of the rail", () => {
    expect(styles).toContain('.wave-rail button[aria-current="page"]');
    expect(styles).toContain("background: var(--orca-surface-hover); border-color: var(--orca-border); color: var(--orca-ink);");
    expect(styles).toContain(".feedback-kit-bottom-right { bottom: 84px; right: 16px; }");
    expect(styles).toContain(".feedback-kit-trigger span { display: none; }");
  });
});

describe("propagated signal controls", () => {
  test("keeps hover, focus, pressed, error, and disabled labels theme-safe", () => {
    expect(styles).toContain("/* BRE-268: propagated signals are a local projection");
    expect(styles).toContain('.agent-events-history-toggle[aria-pressed="true"],');
    expect(styles).toContain("background: var(--orca-surface-hover);");
    expect(styles).toContain("border-color: var(--orca-border);");
    expect(styles).toContain("color: var(--orca-ink);");
    expect(styles).toContain(".agent-event-actions button:focus-visible,");
    expect(styles).toContain("outline: 2px solid var(--orca-accent);");
    expect(styles).toContain(".agent-event-actions button:disabled,");
    expect(styles).toContain(".agent-events-history-toggle:disabled,");
    expect(styles).toContain(".agent-events-error {");
  });

  test("scopes and computes the phone mute-menu containment at 320, 375, and 390px", () => {
    const phone = mediaBlock("(max-width: 390px)");
    expect(phone).toContain("/* BRE-302: give the mute popover the card's full inline width at supported phone widths. */");
    expect(phone).toContain(".agent-event-mute-menu { flex: 0 0 100%; min-width: 0; }");
    expect(phone).toContain(".agent-event-mute-menu summary { width: max-content; }");
    expect(phone).toContain(".agent-event-mute-menu > div { left: 0; min-width: 0; right: 0; width: auto; }");
    for (const width of [320, 375, 390]) {
      expect(responsiveSignalStyles(width).menu).toEqual({ flex: "0 0 100%", left: "0px", minWidth: "0", right: "0px", width: "auto" });
    }
    expect(responsiveSignalStyles(391).menu.flex).not.toBe("0 0 100%");
  });

  test("scopes and computes the inbox scrollport through the 860px boundary without changing readers", () => {
    const mobile = mediaBlock("(max-width: 860px)");
    expect(mobile).toContain("/* BRE-303: keep inbox content in a scrollport above the fixed mobile controls. */");
    expect(mobile).toContain(".content-pane:not(.content-pane-reader) { height: calc(100vh - 144px)");
    expect(mobile).toContain("height: calc(100dvh - 144px)");
    expect(mobile).toContain("min-height: 0");
    expect(mobile).toContain("overflow-y: auto");
    expect(mobile).toContain("overscroll-behavior-y: contain");
    expect(mobile).not.toContain(".content-pane-reader { height:");

    for (const width of [320, 375, 390, 860]) {
      const computed = responsiveSignalStyles(width);
      expect(computed.pane.height).toBe("calc(100dvh - 144px)");
      expect(computed.pane.minHeight).toBe("0");
      expect(computed.pane.overflowY).toBe("auto");
      expect(computed.reader.height).not.toContain("144px");
      expect(computed.reader.minHeight).not.toBe("0");
      expect(computed.reader.overflowY).not.toBe("auto");
    }

    const desktop = responsiveSignalStyles(861);
    expect(desktop.pane.height).not.toContain("144px");
    expect(desktop.pane.minHeight).not.toBe("0");
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
