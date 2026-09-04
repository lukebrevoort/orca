import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageSubject } from "./App";
import { AppSidebar } from "./desktop-switch";

const styles = await Bun.file(new URL("./desktop-switch.css", import.meta.url)).text();
const baseStyles = await Bun.file(new URL("./styles.css", import.meta.url)).text();

function desktopShellStyles() {
  const browser = new Window({ height: 900, width: 1440 });
  const sheet = browser.document.createElement("style");
  sheet.textContent = styles;
  browser.document.head.append(sheet);

  const shell = browser.document.createElement("main");
  shell.className = "desktop-shell";
  const sidebar = browser.document.createElement("aside");
  sidebar.className = "desktop-sidebar";
  const workspace = browser.document.createElement("section");
  workspace.className = "desktop-workspace";
  shell.append(sidebar, workspace);
  browser.document.body.append(shell);

  const shellStyle = browser.getComputedStyle(shell);
  const sidebarStyle = browser.getComputedStyle(sidebar);
  const workspaceStyle = browser.getComputedStyle(workspace);
  const result = {
    shell: { height: shellStyle.height, overflow: shellStyle.overflow },
    sidebar: { height: sidebarStyle.height },
    workspace: { height: workspaceStyle.height, minHeight: workspaceStyle.minHeight, overflowY: workspaceStyle.overflowY },
  };
  browser.close();
  return result;
}

function responsiveShellStyles(width: number, theme: "light" | "dark", view: "inbox" | "later" = "inbox", density: "calm" | "compact" = "calm", includeRowStates = false) {
  const browser = new Window({ height: 844, width });
  browser.document.documentElement.dataset.theme = theme;
  browser.document.documentElement.dataset.readerDensity = density;
  const sheet = browser.document.createElement("style");
  sheet.textContent = `${baseStyles}\n${styles}`;
  browser.document.head.append(sheet);

  const shell = browser.document.createElement("main");
  shell.className = "desktop-shell";
  const sidebar = browser.document.createElement("aside");
  sidebar.className = "desktop-sidebar";
  const desktopContent = browser.document.createElement("div");
  desktopContent.className = "desktop-sidebar-content";
  const mobileNavigation = browser.document.createElement("nav");
  mobileNavigation.className = "desktop-mobile-navigation";
  const mobileItem = browser.document.createElement("button");
  mobileItem.className = "desktop-mobile-nav-item";
  mobileItem.setAttribute("aria-current", "page");
  mobileNavigation.append(mobileItem);
  sidebar.append(desktopContent, mobileNavigation);

  const workspace = browser.document.createElement("section");
  workspace.className = "desktop-workspace";
  const inbox = browser.document.createElement("section");
  inbox.className = `inbox-view${view === "later" ? " inbox-view-later" : ""}`;
  const body = browser.document.createElement("div");
  body.className = "inbox-body";
  const list = browser.document.createElement("ol");
  list.className = "message-list";
  const listItem = browser.document.createElement("li");
  const wrap = browser.document.createElement("div");
  wrap.className = "message-row-wrap";
  const row = browser.document.createElement("button");
  row.className = "message-row";
  const avatar = browser.document.createElement("span");
  avatar.className = "stream-avatar";
  const copy = browser.document.createElement("div");
  copy.className = "message-copy";
  const meta = browser.document.createElement("div");
  meta.className = "message-meta";
  const sender = browser.document.createElement("strong");
  const date = browser.document.createElement("span");
  meta.append(sender, date);
  const subject = browser.document.createElement("div");
  subject.className = "message-subject-row";
  const subjectHeading = browser.document.createElement("h2");
  subjectHeading.textContent = "A restrained subject line";
  subject.append(subjectHeading);
  const snippet = browser.document.createElement("p");
  copy.append(meta, subject, snippet);
  row.append(avatar, copy);
  const evidence = browser.document.createElement("button");
  evidence.className = "message-evidence-button";
  const attention = browser.document.createElement("div");
  attention.className = "sender-attention-control";
  const attentionTrigger = browser.document.createElement("button");
  attentionTrigger.className = "sender-attention-trigger";
  attention.append(attentionTrigger);
  const keep = browser.document.createElement("button");
  keep.className = "keep-thread-button";
  const laterActions = browser.document.createElement("div");
  laterActions.className = "later-row-actions";
  wrap.append(row, evidence, attention, ...(view === "later" ? [laterActions] : [keep]));
  listItem.append(wrap);
  const unreadListItem = browser.document.createElement("li");
  const unreadWrap = browser.document.createElement("div");
  unreadWrap.className = "message-row-wrap";
  const unreadRow = row.cloneNode(true) as typeof row;
  unreadRow.classList.add("message-row-unread");
  const unreadSubject = unreadRow.querySelector(".message-subject-row")!;
  const unreadMarker = browser.document.createElement("span");
  unreadMarker.className = "message-unread-dot";
  unreadSubject.append(unreadMarker);
  unreadWrap.append(unreadRow);
  unreadListItem.append(unreadWrap);
  list.append(listItem, unreadListItem);
  let selectedUnreadRow: typeof row | null = null;
  let disabledUnreadRow: typeof row | null = null;
  if (includeRowStates) {
    const selectedListItem = browser.document.createElement("li");
    const selectedUnreadWrap = unreadWrap.cloneNode(true) as typeof unreadWrap;
    selectedUnreadWrap.classList.add("message-row-wrap-selecting", "message-row-wrap-selected");
    selectedUnreadRow = selectedUnreadWrap.querySelector(".message-row") as typeof row;
    selectedUnreadRow.setAttribute("aria-pressed", "true");
    const selectionIndicator = browser.document.createElement("span");
    selectionIndicator.className = "message-select-indicator";
    selectedUnreadRow.prepend(selectionIndicator);
    selectedListItem.append(selectedUnreadWrap);
    const disabledListItem = browser.document.createElement("li");
    const disabledUnreadWrap = selectedUnreadWrap.cloneNode(true) as typeof unreadWrap;
    disabledUnreadWrap.classList.remove("message-row-wrap-selected");
    disabledUnreadRow = disabledUnreadWrap.querySelector(".message-row") as typeof row;
    disabledUnreadRow.removeAttribute("aria-pressed");
    disabledUnreadRow.disabled = true;
    disabledListItem.append(disabledUnreadWrap);
    list.append(selectedListItem, disabledListItem);
  }
  body.append(list);
  inbox.append(body);
  workspace.append(inbox);
  shell.append(sidebar, workspace);
  browser.document.body.append(shell);

  const mobileStyle = browser.getComputedStyle(mobileNavigation);
  const desktopContentStyle = browser.getComputedStyle(desktopContent);
  const mobileItemStyle = browser.getComputedStyle(mobileItem);
  const rowStyle = browser.getComputedStyle(row);
  const unreadRowStyle = browser.getComputedStyle(unreadRow);
  const copyStyle = browser.getComputedStyle(copy);
  const readSenderStyle = browser.getComputedStyle(sender);
  const readSubjectStyle = browser.getComputedStyle(subjectHeading);
  const unreadSenderStyle = browser.getComputedStyle(unreadRow.querySelector(".message-meta strong")!);
  const unreadSubjectStyle = browser.getComputedStyle(unreadRow.querySelector(".message-subject-row h2")!);
  const unreadMarkerStyle = browser.getComputedStyle(unreadMarker);
  let focusedUnreadRow = null;
  let selectedUnreadState = null;
  let disabledUnreadState = null;
  if (selectedUnreadRow && disabledUnreadRow) {
    const selectedUnreadRowStyle = browser.getComputedStyle(selectedUnreadRow);
    const selectedUnreadMarkerStyle = browser.getComputedStyle(selectedUnreadRow.querySelector(".message-unread-dot")!);
    const disabledUnreadRowStyle = browser.getComputedStyle(disabledUnreadRow);
    const disabledUnreadMarkerStyle = browser.getComputedStyle(disabledUnreadRow.querySelector(".message-unread-dot")!);
    unreadRow.focus();
    const focusedUnreadRowStyle = browser.getComputedStyle(unreadRow);
    focusedUnreadRow = { outlineColor: focusedUnreadRowStyle.outlineColor, outlineOffset: focusedUnreadRowStyle.outlineOffset, outlineWidth: focusedUnreadRowStyle.outlineWidth };
    selectedUnreadState = { background: selectedUnreadRowStyle.backgroundColor, color: selectedUnreadRowStyle.color, markerDisplay: selectedUnreadMarkerStyle.display, paddingLeft: selectedUnreadRowStyle.paddingLeft };
    disabledUnreadState = { color: disabledUnreadRowStyle.color, markerDisplay: disabledUnreadMarkerStyle.display, paddingLeft: disabledUnreadRowStyle.paddingLeft };
  }
  const dateStyle = browser.getComputedStyle(date);
  const evidenceStyle = browser.getComputedStyle(evidence);
  const attentionStyle = browser.getComputedStyle(attentionTrigger);
  const attentionControlStyle = browser.getComputedStyle(attention);
  const keepStyle = browser.getComputedStyle(keep);
  const laterActionsStyle = browser.getComputedStyle(laterActions);
  const result = {
    desktopContentDisplay: desktopContentStyle.display,
    mobileDisplay: mobileStyle.display,
    mobileItem: { background: mobileItemStyle.backgroundColor, color: mobileItemStyle.color, minHeight: mobileItemStyle.minHeight },
    row: { background: rowStyle.backgroundColor, gridTemplateColumns: rowStyle.gridTemplateColumns, minHeight: rowStyle.minHeight, paddingBottom: rowStyle.paddingBottom, paddingRight: rowStyle.paddingRight, senderWeight: readSenderStyle.fontWeight, subjectWeight: readSubjectStyle.fontWeight },
    unreadRow: { background: unreadRowStyle.backgroundColor, gridTemplateColumns: unreadRowStyle.gridTemplateColumns, minHeight: unreadRowStyle.minHeight, paddingBottom: unreadRowStyle.paddingBottom, paddingRight: unreadRowStyle.paddingRight, senderWeight: unreadSenderStyle.fontWeight, subjectWeight: unreadSubjectStyle.fontWeight },
    unreadMarker: { background: unreadMarkerStyle.backgroundColor, display: unreadMarkerStyle.display, height: unreadMarkerStyle.height, left: unreadMarkerStyle.left, position: unreadMarkerStyle.position, width: unreadMarkerStyle.width },
    focusedUnreadRow,
    selectedUnreadRow: selectedUnreadState,
    disabledUnreadRow: disabledUnreadState,
    copy: { gridTemplateColumns: copyStyle.gridTemplateColumns, gridTemplateRows: copyStyle.gridTemplateRows },
    datePosition: dateStyle.position,
    evidence: { bottom: evidenceStyle.bottom, minHeight: evidenceStyle.minHeight, right: evidenceStyle.right, top: evidenceStyle.top },
    attention: { bottom: attentionControlStyle.bottom, minHeight: attentionStyle.minHeight },
    keep: { height: keepStyle.height, width: keepStyle.width },
    laterActionsBottom: laterActionsStyle.bottom,
  };
  browser.close();
  return result;
}

function responsiveInboxHeaderStyles(width: number, theme: "light" | "dark", density: "calm" | "compact") {
  const browser = new Window({ height: 844, width });
  browser.document.documentElement.dataset.theme = theme;
  browser.document.documentElement.dataset.readerDensity = density;
  const sheet = browser.document.createElement("style");
  sheet.textContent = `${baseStyles}\n${styles}`;
  browser.document.head.append(sheet);

  const shell = browser.document.createElement("main");
  shell.className = "desktop-shell";
  const sidebar = browser.document.createElement("aside");
  sidebar.className = "desktop-sidebar";
  const workspace = browser.document.createElement("section");
  workspace.className = "desktop-workspace";
  const contentPane = browser.document.createElement("div");
  contentPane.className = "content-pane";
  const inbox = browser.document.createElement("section");
  inbox.className = "inbox-view inbox-view-inbox";
  const header = browser.document.createElement("header");
  header.className = "pane-header";
  const heading = browser.document.createElement("div");
  const titleLine = browser.document.createElement("div");
  titleLine.className = "stream-title-line";
  const title = browser.document.createElement("h1");
  title.textContent = "What deserves you now";
  const count = browser.document.createElement("span");
  count.textContent = "5 unread · 5 pins";
  titleLine.append(title, count);
  heading.append(titleLine);
  const headerTools = browser.document.createElement("div");
  headerTools.className = "stream-header-tools";
  const select = browser.document.createElement("button");
  select.className = "selection-mode-toggle";
  select.textContent = "Select";
  headerTools.append(select);
  header.append(heading, headerTools);
  inbox.append(header);
  contentPane.append(inbox);
  workspace.append(contentPane);
  shell.append(sidebar, workspace);
  browser.document.body.append(shell);

  const contentPaneStyle = browser.getComputedStyle(contentPane);
  const headerStyle = browser.getComputedStyle(header);
  const headingStyle = browser.getComputedStyle(heading);
  const headerToolsStyle = browser.getComputedStyle(headerTools);
  const selectStyle = browser.getComputedStyle(select);
  const result = {
    actionDisplay: selectStyle.display,
    actionMinHeight: selectStyle.minHeight,
    contentMaxWidth: contentPaneStyle.maxWidth,
    contentWidth: contentPaneStyle.width,
    gridTemplateColumns: headerStyle.gridTemplateColumns,
    headingMinWidth: headingStyle.minWidth,
    toolsDisplay: headerToolsStyle.display,
  };
  browser.close();
  return result;
}

describe("desktop application shell", () => {
  test("exposes one named primary navigation landmark and one current destination", () => {
    const html = renderToStaticMarkup(createElement(AppSidebar, {
      projection: {
        account: { displayName: "Luke Brevoort", email: "luke@example.com", accountCount: 1, health: "synced" },
        active: "inbox",
        inboxCount: 4,
        draftCount: 2,
        online: true,
        spaces: [{ id: "focus", label: "Focus", description: "protected attention" }],
      },
      theme: "light",
      onCompose: () => undefined,
      onManageSpaces: () => undefined,
      onNavigate: () => undefined,
    }));
    const browser = new Window();
    browser.document.body.innerHTML = html;

    const primary = browser.document.querySelector('nav[aria-label="Primary navigation"]');
    const current = primary?.querySelectorAll('[aria-current="page"]') ?? [];
    expect(primary).not.toBeNull();
    expect(browser.document.querySelector('aside[aria-label="Primary"]')).toBeNull();
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain("Inbox");
    browser.close();
  });

  test("keeps the sidebar in the viewport while the workspace owns long-page scrolling", () => {
    const computed = desktopShellStyles();

    expect(computed.shell.height).toBe("900px");
    expect(computed.shell.overflow).toBe("hidden");
    expect(computed.sidebar.height).toBe("100%");
    expect(computed.workspace.height).toBe("100%");
    expect(computed.workspace.minHeight).toBe("0");
    expect(computed.workspace.overflowY).toBe("auto");
  });

  test("switches to complete, theme-safe mobile navigation only through 760px", () => {
    for (const width of [320, 390, 760]) {
      for (const theme of ["light", "dark"] as const) {
        const computed = responsiveShellStyles(width, theme);
        expect(computed.desktopContentDisplay).toBe("none");
        expect(computed.mobileDisplay).toBe("grid");
        expect(computed.mobileItem.minHeight).toBe("54px");
        expect(computed.mobileItem.background).not.toBe("transparent");
        expect(computed.mobileItem.color).not.toBe("transparent");
      }
    }

    const desktop = responsiveShellStyles(1024, "light");
    expect(desktop.desktopContentDisplay).toBe("flex");
    expect(desktop.mobileDisplay).toBe("none");
  }, 15_000);

  test("reflows mobile message anatomy into content and 44px action bands", () => {
    for (const width of [320, 390, 760]) {
      for (const theme of ["light", "dark"] as const) {
        const computed = responsiveShellStyles(width, theme);
        expect(computed.row.gridTemplateColumns).toContain("minmax(0,1fr)");
        expect(computed.row.minHeight).toBe("138px");
        expect(computed.row.paddingBottom).toBe("64px");
        expect(computed.row.paddingRight).toBe("12px");
        expect(computed.copy.gridTemplateColumns).toContain("minmax(0,1fr)");
        expect(computed.copy.gridTemplateRows).toBe("auto auto auto");
        expect(computed.datePosition).toBe("static");
        expect(computed.evidence).toEqual({ bottom: "10px", minHeight: "44px", right: "104px", top: "auto" });
        expect(computed.attention.minHeight).toBe("44px");
        expect(computed.keep).toEqual({ height: "44px", width: "44px" });
      }
    }

    const desktop = responsiveShellStyles(1024, "light");
    expect(desktop.mobileDisplay).toBe("none");
    expect(desktop.row.paddingRight).toBe("252px");
    expect(desktop.datePosition).toBe("absolute");
  }, 15_000);

  test("bounds Inbox heading actions to the desktop workspace at narrow and wide widths", () => {
    for (const width of [1024, 1280, 1440]) {
      for (const theme of ["light", "dark"] as const) {
        for (const density of ["calm", "compact"] as const) {
          const computed = responsiveInboxHeaderStyles(width, theme, density);

          expect(computed.contentWidth).toBe("100%");
          expect(computed.contentMaxWidth).toBe("880px");
          expect(computed.gridTemplateColumns).toBe("minmax(0, 1fr) auto");
          expect(computed.headingMinWidth).toBe("0");
          expect(computed.toolsDisplay).toBe("flex");
          expect(computed.actionDisplay).not.toBe("none");
          expect(computed.actionMinHeight).toBe("38px");
        }
      }
    }

    for (const theme of ["light", "dark"] as const) {
      for (const density of ["calm", "compact"] as const) {
        const mobile = responsiveInboxHeaderStyles(390, theme, density);
        expect(mobile.contentWidth).not.toBe("100%");
        expect(mobile.contentMaxWidth).toBe("none");
      }
    }
  }, 10_000);

  test("keeps compact Later evidence, attention, and reminder actions in separate bands", () => {
    for (const theme of ["light", "dark"] as const) {
      const computed = responsiveShellStyles(390, theme, "later", "compact");
      expect(computed.evidence.bottom).toBe("64px");
      expect(computed.attention.bottom).toBe("64px");
      expect(computed.attention.minHeight).toBe("44px");
      expect(computed.laterActionsBottom).toBe("10px");
    }
  });

  test("keeps compact read and unread rows restrained, scannable, and aligned", () => {
    for (const width of [1024, 1440]) {
      for (const theme of ["light", "dark"] as const) {
        const compact = responsiveShellStyles(width, theme, "inbox", "compact", true);
        expect(compact.row.minHeight).toBe("72px");
        expect(compact.unreadRow.minHeight).toBe("72px");
        expect(compact.unreadRow.gridTemplateColumns).toBe(compact.row.gridTemplateColumns);
        expect(compact.unreadRow.paddingRight).toBe(compact.row.paddingRight);
        expect(compact.unreadRow.paddingBottom).toBe(compact.row.paddingBottom);
        expect(compact.unreadRow.background).toBe(compact.row.background);
        expect(Number(compact.unreadRow.senderWeight)).toBeGreaterThan(Number(compact.row.senderWeight));
        expect(Number(compact.unreadRow.subjectWeight)).toBeGreaterThan(Number(compact.row.subjectWeight));
        expect(compact.unreadMarker).toEqual({
          background: theme === "dark" ? "#6aa9f5" : "#087461",
          display: "block",
          height: "14px",
          left: "-9px",
          position: "absolute",
          width: "3px",
        });
        expect(compact.focusedUnreadRow!.outlineWidth).toBe("2px");
        expect(compact.focusedUnreadRow!.outlineOffset).toBe("2px");
        expect(compact.focusedUnreadRow!.outlineColor).toBe(theme === "dark" ? "#6aa9f5" : "#087461");
        expect(compact.selectedUnreadRow!.background).not.toBe(compact.unreadRow.background);
        expect(compact.selectedUnreadRow!.color).toBe(theme === "dark" ? "#f4f3ef" : "#0f2422");
        expect(compact.selectedUnreadRow!.markerDisplay).toBe("block");
        expect(compact.selectedUnreadRow!.paddingLeft).toBe("62px");
        expect(compact.disabledUnreadRow!.color).toBe(theme === "dark" ? "#f4f3ef" : "#0f2422");
        expect(compact.disabledUnreadRow!.markerDisplay).toBe("block");
        expect(compact.disabledUnreadRow!.paddingLeft).toBe("62px");
      }
    }

    for (const width of [1024, 1440]) {
      for (const theme of ["light", "dark"] as const) {
        const calm = responsiveShellStyles(width, theme, "inbox", "calm");
        expect(calm.row.minHeight).toBe("92px");
        expect(calm.unreadRow.minHeight).toBe("92px");
        expect(calm.unreadRow.gridTemplateColumns).toBe(calm.row.gridTemplateColumns);
        if (theme === "dark") expect(calm.unreadRow.background).toBe("#121212");
        else expect(calm.unreadRow.background).toBe("#ffffff");
      }
    }
  }, 15_000);

  test("renders the compact unread marker only in unread message markup", () => {
    const readMarkup = renderToStaticMarkup(createElement(MessageSubject, { subject: "Read update", unread: false }));
    const unreadMarkup = renderToStaticMarkup(createElement(MessageSubject, { subject: "Unread update", unread: true }));
    const browser = new Window();
    browser.document.body.innerHTML = `${readMarkup}${unreadMarkup}`;

    const subjects = browser.document.querySelectorAll(".message-subject-row");
    expect(subjects).toHaveLength(2);
    expect(subjects[0]?.querySelector(".message-unread-dot")).toBeNull();
    expect(subjects[1]?.querySelector(".message-unread-dot")).not.toBeNull();
    expect(subjects[1]?.querySelector("h2")?.textContent).toBe("Unread update");
    browser.close();
  });
});
