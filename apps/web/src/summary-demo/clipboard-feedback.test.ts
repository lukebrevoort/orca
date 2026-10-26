import { expect, test } from "bun:test";
import { clipboardFeedback } from "./clipboard-feedback";
test("clipboard outcomes have clear feedback", () => {
  expect(clipboardFeedback("copied")).toBe("Code copied.");
  expect(clipboardFeedback("expired")).toBe("Code expired. Nothing copied.");
  expect(clipboardFeedback("failed")).toContain("manually");
});
