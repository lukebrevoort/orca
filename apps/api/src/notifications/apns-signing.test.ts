import { test, expect } from "bun:test";
import { resolve } from "node:path";

test("BRE-470 correction during production APNs signing prevents opening an HTTP/2 request", () => {
  const child = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "apns-signing.probe.ts"), "correction"], { stdout: "pipe", stderr: "pipe", timeout: 10000 });
  if (child.exitCode !== 0) throw Error(child.stderr.toString() + child.stdout.toString());
  const result = JSON.parse(child.stdout.toString().trim());
  expect(result.change).toBe("correction");
  expect(result.requests).toBe(0);
  expect(result.connections).toBe(0);
  expect(result.result.delivered).toBe(0);
});
