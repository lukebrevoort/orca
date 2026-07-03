import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { validator } from "hono/validator";
import {
  accountFixture,
  authSessionFixture,
  authSessionSchema,
  inboxFixture,
  inboxQuerySchema,
  inboxResponseSchema,
  mailAccountSchema,
} from "@orca/shared";

import { createGmailAuthApp } from "./auth/gmail/routes.ts";
import { getServerConfig } from "./config/server.ts";

const serverConfig = getServerConfig();

export function createApp(): Hono {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: [serverConfig.webOrigin],
    }),
  );

  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "orca-api",
    }),
  );

  app.get("/v1/auth/session", (c) => jsonWithSchema(c, authSessionSchema, authSessionFixture));

  app.get("/v1/me", (c) => jsonWithSchema(c, mailAccountSchema, accountFixture));

  app.get(
    "/v1/inbox",
    validator("query", (value, c) => {
      const result = inboxQuerySchema.safeParse(value);
      if (!result.success) {
        return c.json(
          {
            error: {
              code: "validation_error",
              message: "Invalid inbox query parameters",
              issues: result.error.issues.map((issue) => ({
                path: issue.path.join(".") || "query",
                message: issue.message,
              })),
            },
          } satisfies ValidationErrorResponse,
          400,
        );
      }

      return result.data;
    }),
    (c) => {
      c.req.valid("query");

      return jsonWithSchema(c, inboxResponseSchema, {
        account: accountFixture,
        messages: inboxFixture,
        nextCursor: null,
      });
    },
  );

  app.route("/v1/auth/gmail", createGmailAuthApp());

  return app;
}

export const app = createApp();

type ValidationErrorResponse = {
  error: {
    code: "validation_error";
    message: string;
    issues: Array<{
      path: string;
      message: string;
    }>;
  };
};

type JsonSchema<T> = {
  parse(value: unknown): T;
};

function jsonWithSchema<T>(
  c: Context,
  schema: JsonSchema<T>,
  value: unknown,
) {
  return c.json(schema.parse(value));
}

const { port } = serverConfig;

if (import.meta.main) {
  serve({
    fetch: app.fetch,
    port,
  });

  console.log(`Orca API listening on http://localhost:${port}`);
}
