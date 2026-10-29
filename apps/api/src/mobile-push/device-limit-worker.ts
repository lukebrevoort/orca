// Test-only subprocess. The parent supplies auth configuration before imports run.
import { createDatabaseClient } from "../db/client.ts";
import { DeviceLimitError, registerDevice } from "./store.ts";

const [path, installationId, token] = process.argv.slice(2);
const client = createDatabaseClient(path!);
// Announce transaction entry before SQLite blocks on the parent's write lock.
const transaction = client.sqlite.transaction.bind(client.sqlite);
client.sqlite.transaction = ((callback: () => unknown) => {
  const wrapped = transaction(callback);
  return Object.assign(() => wrapped(), {
    immediate: () => { console.log("locking"); return wrapped.immediate(); },
    deferred: () => { console.log("locking"); return wrapped.deferred(); },
    exclusive: () => wrapped.exclusive(),
  });
}) as typeof client.sqlite.transaction;
try {
  console.log("ready");
  const input = Bun.stdin.stream().getReader();
  await input.read();
  input.releaseLock();
  await registerDevice(client.sqlite, {
    userId: "owner", sessionId: "session-owner", installationId: installationId!, token: token!,
    environment: "sandbox", notificationSelection: { inbox: true, spaceIds: [] }, now: new Date(3_000),
  });
  console.log("ok");
} catch (error) {
  console.log(error instanceof DeviceLimitError ? "limit" : `err:${String(error)}`);
} finally {
  client.sqlite.close();
}
