import { describe, expect, test } from "bun:test";

import { requestForApi } from "./vercel-api.ts";

describe("Vercel API bridge", () => {
  test("preserves Orca query parameters while removing Vercel transport metadata", () => {
    const request = new Request(
      "https://orca.example/api?__orca_path=%2Fv1%2Finbox&view=all&_vercel_share=preview-token&path=%2Fv1%2Finbox",
    );

    const rewritten = requestForApi(request);
    const url = new URL(rewritten.url);

    expect(url.pathname).toBe("/v1/inbox");
    expect(url.search).toBe("?view=all");
  });

  test("maps direct API requests without a rewritten path", () => {
    const rewritten = requestForApi(new Request("https://orca.example/api/health"));

    expect(new URL(rewritten.url).pathname).toBe("/health");
  });
});
