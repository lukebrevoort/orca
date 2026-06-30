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
  meResponseSchema,
} from "@orca/shared";

export const app = new Hono();

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

app.get("/v1/auth/session", (c) =>
  jsonWithSchema(c, authSessionSchema, authSessionFixture),
);

app.get("/v1/me", (c) => jsonWithSchema(c, meResponseSchema, accountFixture));

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
    void c.req.valid("query");

    return jsonWithSchema(c, inboxResponseSchema, {
      account: accountFixture,
      messages: inboxFixture,
      nextCursor: null,
    });
  },
);

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

function jsonWithSchema<T>(c: Context, schema: JsonSchema<T>, value: unknown) {
  return c.json(schema.parse(value));
}

const port = Number(process.env.PORT ?? 3000);

if (import.meta.main) {
  serve({
    fetch: app.fetch,
    port,
  });

  console.log(`Orca API listening on http://localhost:${port}`);
}
