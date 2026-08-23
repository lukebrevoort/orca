import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";

const ixdRoot = import.meta.dir;
const prototypes = ["phase7-prototype-desktop.html", "phase7-prototype-mobile.html"];

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
});

describe("BRE-307 prototype accessibility", () => {
  test("desktop and mobile have no axe critical or serious violations with dialogs closed or open", async () => {
    for (const file of prototypes) {
      const window = new Window({ url: "http://localhost/organization" });
      window.document.write(readFileSync(join(ixdRoot, file), "utf8"));
      (globalThis as { window?: unknown }).window = window;
      (globalThis as { document?: unknown }).document = window.document;
      const axe = (await import("axe-core")).default;
      const runAxe = () => axe.run(window.document, {
        resultTypes: ["violations"],
        rules: {
          "color-contrast": { enabled: false },
          "landmark-one-main": { enabled: false },
        },
      });
      const closed = await runAxe();
      window.document.querySelector("dialog")?.setAttribute("open", "");
      const opened = await runAxe();
      const blocking = [...closed.violations, ...opened.violations].filter((violation) =>
        violation.impact === "critical" || violation.impact === "serious",
      );

      expect(blocking).toEqual([]);
      await window.close();
    }
  }, 30_000);
});
