import { expect, test } from "bun:test";
import { decodeMailPreview } from "./mail-preview";
test("decodes double-encoded apostrophes without unbounded decoding", () => {
  expect(decodeMailPreview("Here&amp;#39;s the plan")).toBe("Here's the plan");
  expect(decodeMailPreview("AT&amp;T")).toBe("AT&T");
  expect(decodeMailPreview("&amp;amp;amp;")).toBe("&amp;");
  expect(decodeMailPreview("&lt;script&gt;literal&lt;/script&gt;")).toBe("<script>literal</script>");
});
