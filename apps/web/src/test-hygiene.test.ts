import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

// Lower this whenever fixed waits are removed; raising it requires a documented reason.
const FIXED_WAIT_CEILING = 42;
const sourceRoot = import.meta.dir;

function testFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? testFiles(path)
      : /\.test\.tsx?$/.test(entry.name) && path !== import.meta.path ? [path] : [];
  });
}

test("fixed-delay waits do not exceed the recorded ceiling", () => {
  // Zero-delay timers yield to the event loop; they are not fixed-delay waits.
  const waits = /\bsetTimeout\s*\(\s*(?:[^()]|\([^()]*\))*?,\s*(\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)\s*(?=[,)])|\bBun\.sleep\s*\(\s*(\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)\s*\)/gi;
  const counts = testFiles(sourceRoot).sort().map((path) => {
    const count = [...readFileSync(path, "utf8").matchAll(waits)]
      .filter((match) => Number((match[1] ?? match[2])!.replaceAll("_", "")) >= 1).length;
    return { file: relative(sourceRoot, path), count };
  }).filter(({ count }) => count > 0);
  const total = counts.reduce((sum, { count }) => sum + count, 0);
  expect(total, [
    `Fixed waits: ${total}; ceiling: ${FIXED_WAIT_CEILING}.`,
    "Lowering the number is good; raising it is not allowed without a documented reason.",
    ...counts.map(({ file, count }) => `${file}: ${count}`),
  ].join("\n")).toBeLessThanOrEqual(FIXED_WAIT_CEILING);
});
