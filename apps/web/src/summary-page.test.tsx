import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SummaryPage } from "./summary-page";

test("Summary placeholder exposes a named section and its heading", () => {
  const html = renderToStaticMarkup(<SummaryPage />);
  expect(html).toContain('aria-labelledby="summary-title"');
  expect(html).toContain('<h1 id="summary-title">Summary</h1>');
  expect(html).toContain("Your summary will appear here.");
});
