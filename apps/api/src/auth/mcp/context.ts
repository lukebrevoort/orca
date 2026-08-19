import { mcpOAuthScopeSchema } from "@orca/shared";
import { z } from "zod";

export const orcaMcpAuthorizationContextSchema = z.object({
  connectionId: z.string().min(1),
  userId: z.string().min(1),
  clientId: z.string().min(1),
  clientName: z.string().min(1),
  issuer: z.string().url(),
  resource: z.string().url(),
  scopes: z.array(mcpOAuthScopeSchema),
  accountIds: z.array(z.string().min(1)),
  issuedAt: z.date(),
  expiresAt: z.date(),
}).strict();

export type OrcaMcpAuthorizationContext = z.infer<typeof orcaMcpAuthorizationContextSchema>;
