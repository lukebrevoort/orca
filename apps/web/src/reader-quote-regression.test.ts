import { expect, test } from "bun:test";
import { splitQuotedContent } from "./reader-body";

test("quote folding never hides an inline answer or forwarded prose", () => {
  for (const body of ["Reply\n> old\nUnique answer", "Reply\nOn Monday, Sam wrote:\n> old\nUnique answer", "Reply\n--- Forwarded message ---\nUnique forwarded text"]) {
    expect(splitQuotedContent(body)).toEqual({ current: body, quoted: null });
  }
});
test("folding retains every character including CRLF and surrounding whitespace", () => {
  const body = "  Reply\r\n\r\nOn Monday, Sam wrote:\r\n> old\r\n";
  const parts = splitQuotedContent(body);
  expect(parts.quoted).toContain("> old");
  expect(parts.current + (parts.quoted ?? "")).toBe(body);
});
