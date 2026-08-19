import { mcpOAuthScopeSchema } from "@orca/shared";
import { z } from "zod";

export const orcaMcpAuthorizationContextSchema = z.object({
  connectionId: z.string().min(1),
  userId: z.string().min(1),
  clientId: z.string().min(1),
  clientName: z.string().min(1),
  resource: z.string().url(),
  scopes: z.array(mcpOAuthScopeSchema),
  accountIds: z.array(z.string().min(1)),
  expiresAt: z.date(),
}).strict();

export type OrcaMcpAuthorizationContext = z.infer<typeof orcaMcpAuthorizationContextSchema>;
