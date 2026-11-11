import type { MiddlewareHandler } from "hono";
import { expectedUserIdHeaderName } from "@orca/shared";
import type { AuthVariables } from "./middleware.ts";

/** Optional original-owner precondition; never supplies authentication or ownership. */
export function createOwnerPrecondition(messages: { invalid: string; changed: string }): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    const auth = c.get("auth");
    if (!auth) return c.json({ error: { code: "unauthorized", message: "Sign in to continue" } }, 401);
    const expected = c.req.header(expectedUserIdHeaderName);
    if (expected !== undefined) {
      if (!expected.length || expected.length > 256 || /\s/.test(expected)) {
        return c.json({ error: { code: "invalid_request", message: messages.invalid } }, 400);
      }
      if (expected !== auth.userId) {
        return c.json({ error: { code: "session_owner_changed", message: messages.changed } }, 409);
      }
    }
    await next();
  };
}
export const requireSessionOwner = createOwnerPrecondition({
  invalid: "Invalid session owner precondition",
  changed: "The signed-in account changed. Reload before continuing.",
});
