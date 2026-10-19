import { expect, test } from "bun:test";
import { fixtureCounterResponse } from "./fixture-counter";

test("counter telemetry preserves response and authenticates without leaking request data", async () => {
  const lines: string[] = [];
  const id = "01234567-89ab-cdef-0123-456789abcdef";
  const request = new Request("http://127.0.0.1/__fixture/image-downloads?private=value", {
    headers: { Authorization: "Bearer fixture-secret", "X-Orca-Fixture-Trace": id },
  });
  const response = fixtureCounterResponse(request, "fixture-secret", 7, line => lines.push(line));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ count: 7 });
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain(`id=${id} event=received`);
  expect(lines[1]).toContain("event=response_ready status=200");
  expect(lines.join("\n")).not.toMatch(/fixture-secret|private|Authorization|127\.0\.0\.1/);
});

test("unauthorized requests retain401 and untrusted trace content is never echoed", async () => {
  const lines: string[] = [];
  const response = fixtureCounterResponse(new Request("http://127.0.0.1/", {
    headers: { Authorization: "Bearer wrong-secret", "X-Orca-Fixture-Trace": "::error::secret" },
  }), "fixture-secret", 7, line => lines.push(line));
  expect(response.status).toBe(401);
  expect(await response.text()).toBe("");
  expect(lines.join("\n")).toContain("id=uncorrelated");
  expect(lines.join("\n")).not.toMatch(/secret|::/);
});
