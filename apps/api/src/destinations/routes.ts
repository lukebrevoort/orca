import type { Hono } from "hono";
import { ZodError } from "zod";
import { destinationRoutingQuerySchema } from "@orca/shared";
import { requireAuth, type AuthVariables } from "../auth/middleware.ts";
import { createDatabaseClient } from "../db/client.ts";
import { OrganizationAuthorityError, OrganizationRevisionConflictError } from "../organization/module.ts";
import { OrganizationLaneValidationError, OrganizationSafetyLockError } from "../organization/lanes/module.ts";
import { createDestinations, DestinationError } from "./service.ts";
export function registerDestinationRoutes(app: Hono<{
    Variables: AuthVariables;
}>, { dbFactory = createDatabaseClient }: {
    dbFactory?: typeof createDatabaseClient;
} = {}) {
    for (const [method, path] of [["get", "/v1/destinations"], ["post", "/v1/destinations"], ["get", "/v1/destinations/routing"], ["put", "/v1/destinations/routing"], ["patch", "/v1/destinations/:id"], ["post", "/v1/destinations/:id/retire"]] as const)
        app[method](path, requireAuth({ dbFactory }), async (c) => {
            const { db, sqlite } = dbFactory();
            try {
                const service = createDestinations(db, c.get("auth").userId);
                if (path.endsWith("/routing")) {
                    const q = destinationRoutingQuerySchema.parse(c.req.query());
                    return c.json(method === "get" ? service.read(q.accountId, q.threadId ? { scope: "conversation", threadId: q.threadId } : q.address ? { scope: "sender", address: q.address } : { scope: "account" }) : service.save(q.accountId, await c.req.json()));
                }
                if (method === "get")
                    return c.json(service.list());
                const body = await c.req.json();
                return c.json(path.endsWith("/retire") ? service.retire(c.req.param("id")!, body) : method === "patch" ? service.update(c.req.param("id")!, body) : service.create(body));
            }
            catch (e) {
                if (e instanceof DestinationError)
                    return c.json({ error: { code: e.status === 409 ? "conflict" : "validation_error", message: e.message } }, e.status);
                if (e instanceof OrganizationAuthorityError)
                    return c.json({ error: { code: e.code, message: e.message } }, e.code === "revision_conflict" ? 409 : 403);
                if (e instanceof OrganizationRevisionConflictError || e instanceof OrganizationSafetyLockError || e instanceof OrganizationLaneValidationError)
                    return c.json({ error: { code: "conflict", message: e.message } }, 409);
                if (e instanceof ZodError || e instanceof SyntaxError)
                    return c.json({ error: { code: "validation_error", message: "Check destination, account, and revision." } }, 400);
                throw e;
            }
            finally {
                sqlite.close();
            }
        });
}
