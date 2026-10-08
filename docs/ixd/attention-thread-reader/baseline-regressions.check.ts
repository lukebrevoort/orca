// Explicit RED receipt against the captured production UI and current quote
// parser. Intentionally exits 1 on the unmodified production baseline. This is
// not included in the ordinary *.test.ts suite. Re-capture UI before re-running.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { splitQuotedContent } from "../../../apps/web/src/reader-body";
import { messages } from "./fixture";
const inbox = JSON.parse(readFileSync(new URL("./evidence/baseline-inbox-metrics.json",import.meta.url),"utf8"));
const reader = JSON.parse(readFileSync(new URL("./evidence/baseline-metrics.json",import.meta.url),"utf8"));
const checks = [
  ["All ten attention labels are visible", () => assert.equal(inbox.badges.filter((b: {display:string}) => b.display !== "none").length,10)],
  ["Encoded apostrophes do not leak into preview text", () => assert.equal(inbox.encodedPreviews,0)],
  ["Long thread initially folds earlier message bodies", () => assert.ok(reader.collapsedMessageCards > 0)],
  ["Inline answer after quoted lines remains in current text", () => assert.ok(splitQuotedContent(messages[11]!.bodyText!).current.includes("Unique inline answer"))],
] as const;
let failures = 0;
for (const [name,check] of checks) { try { check(); console.log(`PASS ${name}`); } catch { failures++; console.log(`FAIL ${name}`); } }
console.log(`${failures} of ${checks.length} desired contracts fail on the captured production baseline. No production fix is included in this design stage.`);
process.exitCode = failures ? 1 : 0;
