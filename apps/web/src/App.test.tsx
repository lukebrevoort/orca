import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "./App";

describe("App", () => {
  test("renders the foundational inbox shell", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Orca");
    expect(html).toContain("Compose");
    expect(html).toContain("Inbox");
    expect(html).toContain("Loading inbox");
    expect(html).toContain("Connecting to the read-only API");
    expect(html).toContain("Connecting account...");
  });
});
