import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./reader-body.css", import.meta.url), "utf8");

describe("reader body rendering boundary", () => {
  test("lets the browser skip offscreen layout without removing content", () => {
    expect(css).toMatch(/@supports\s*\(content-visibility:\s*auto\)\s*\{\s*\.reader-content\s*\{\s*content-visibility:\s*auto;\s*contain-intrinsic-block-size:\s*auto\s+1000px;/);
    // Never place sender menus or the entire reader under paint containment.
    expect(css).not.toMatch(/\.(?:reader-message|reader-document|reader-sender)\s*\{[^}]*content-visibility/);
  });
  test("prints all message bodies without estimated heights", () => {
    expect(css).toMatch(/@media\s+print\s*\{\s*\.reader-content\s*\{\s*content-visibility:\s*visible;\s*contain-intrinsic-block-size:\s*none;/);
  });
});
