import { orcaMcpScopeSchema } from "@orca/shared";
import { z } from "zod";

export const orcaMcpMaximumAccessTokenLifetimeSeconds = 10 * 60;

export const orcaAgentAuthorizationContextSchema = z.object({
  connectionId: z.string().min(1),
  clientId: z.string().min(1),
  userId: z.string().min(1),
  accountIds: z.array(z.string().min(1)).min(1),
  issuer: z.string().url(),
  resource: z.string().url(),
  scopes: z.array(orcaMcpScopeSchema).min(1),
  issuedAt: z.date(),
  expiresAt: z.date(),
}).strict().superRefine((value, context) => {
  const lifetimeSeconds = (value.expiresAt.getTime() - value.issuedAt.getTime()) / 1_000;
  if (lifetimeSeconds <= 0 || lifetimeSeconds > orcaMcpMaximumAccessTokenLifetimeSeconds) {
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: `Access token lifetime must be between 1 and ${orcaMcpMaximumAccessTokenLifetimeSeconds} seconds`,
    });
  }
});

export type OrcaAgentAuthorizationContext = z.infer<typeof orcaAgentAuthorizationContextSchema>;
