import { z } from "zod";
const id = z.string().trim().min(1).max(256);
export const destinationResolutionSchema = z.object({ destinationId: id, source: z.enum(["safety_lock", "conversation", "sender", "advanced", "account", "legacy", "fallback"]), locked: z.boolean(), reason: z.string() }).strict();
