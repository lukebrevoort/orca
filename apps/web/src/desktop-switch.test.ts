import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const styles = await Bun.file(new URL("./desktop-switch.css", import.meta.url)).text();

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

describe("desktop application shell", () => {
  test("keeps the sidebar in the viewport while the workspace owns long-page scrolling", () => {
    const computed = desktopShellStyles();

    expect(computed.shell.height).toBe("900px");
    expect(computed.shell.overflow).toBe("hidden");
    expect(computed.sidebar.height).toBe("100%");
    expect(computed.workspace.height).toBe("100%");
    expect(computed.workspace.minHeight).toBe("0");
    expect(computed.workspace.overflowY).toBe("auto");
  });
});
