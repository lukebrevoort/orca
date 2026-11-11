import type { MiddlewareHandler } from "hono";
import type { AuthVariables } from "./middleware.ts";

/** Optional precondition for preference drafts captured before a session switch. */
export const requirePreferenceOwner: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  const auth = c.get("auth");
  if (!auth) return c.json({ error: { code: "unauthorized", message: "Sign in to continue" } }, 401);
  const expected = c.req.header("x-orca-expected-user-id");
  if (expected !== undefined) {
    if (!expected.length || expected.length > 256 || /\s/.test(expected)) {
      return c.json({ error: { code: "invalid_request", message: "Invalid preference owner precondition" } }, 400);
    }
    if (expected !== auth.userId) {
      return c.json({ error: { code: "session_owner_changed", message: "The signed-in account changed. Reload preferences before saving." } }, 409);
    }
  }
  await next();
};
