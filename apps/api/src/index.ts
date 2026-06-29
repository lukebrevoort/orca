import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  accountFixture,
  inboxFixture,
  type InboxListResponse,
  type MeResponse,
} from "@orca/shared";

export const app = new Hono();

const meResponse: MeResponse = accountFixture;

const inboxListResponse: InboxListResponse = {
  account: accountFixture,
  messages: inboxFixture,
  nextCursor: null,
};

app.use(
  "*",
  cors({
    origin: ["http://localhost:5173"],
  }),
);

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "orca-api",
  }),
);

app.get("/v1/me", (c) => c.json(meResponse));

app.get("/v1/inbox", (c) => c.json(inboxListResponse));

const port = Number(process.env.PORT ?? 3000);

if (import.meta.main) {
  serve({
    fetch: app.fetch,
    port,
  });

  console.log(`Orca API listening on http://localhost:${port}`);
}
