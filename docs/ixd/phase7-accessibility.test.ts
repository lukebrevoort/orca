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
  for (const file of prototypes) {
    test(`${file} has no axe critical or serious violations`, async () => {
      const window = new Window({ url: "http://localhost/organization" });
      window.document.write(readFileSync(join(ixdRoot, file), "utf8"));
      (globalThis as { window?: unknown }).window = window;
      (globalThis as { document?: unknown }).document = window.document;
      const axe = (await import("axe-core")).default;
      const result = await axe.run(window.document, {
        resultTypes: ["violations"],
        rules: {
          "color-contrast": { enabled: false },
          "landmark-one-main": { enabled: false },
        },
      });
      const blocking = result.violations.filter((violation) =>
        violation.impact === "critical" || violation.impact === "serious",
      );

      expect(blocking).toEqual([]);
      await window.close();
    });
  }
});
