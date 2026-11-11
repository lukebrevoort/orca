import { test, expect } from "bun:test";
import { resolve } from "node:path";

function probe(change: string) {
  const child = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "apns-signing.probe.ts"), change], { stdout: "pipe", stderr: "pipe", timeout: 10000 });
  if (child.exitCode !== 0) throw Error(child.stderr.toString() + child.stdout.toString());
  return JSON.parse(child.stdout.toString().trim());
}
for (const change of ["correction", "read", "session", "account", "permission", "token", "configuration", "lease", "lease-owner"]) {
  test(`BRE-470 ${change} during production APNs signing prevents opening an HTTP/2 request`, () => {
    const result = probe(change);
    expect(result.change).toBe(change);
    expect(result.requests).toBe(0);
    expect(result.connections).toBe(0);
    expect(result.result.delivered).toBe(0);
    expect(result.outbox.every((row: { attempt_count: number }) => row.attempt_count === 0)).toBe(true);
    if (change === "lease" || change === "lease-owner") expect(result.outbox[0].state).toBe("delivering");
  });
}
test("BRE-470 unchanged authority reaches the production request boundary once", () => {
  const result = probe("unchanged");
  expect(result.requests).toBe(1);
  expect(result.connections).toBe(1);
  expect(result.result.delivered).toBe(1);
  expect(result.outbox[0].state).toBe("sent");
  expect(result.outbox[0].attempt_count).toBe(1);
});
