export type AgentFeatureFlags = {
  propagationEnabled: boolean;
  mcpEnabled: boolean;
};

function optionalBooleanFlag(name: string, value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "0" || value.toLowerCase() === "false") return false;
  if (value === "1" || value.toLowerCase() === "true") return true;
  throw new Error(`${name} must be true, false, 1, or 0`);
}

/** M6 surfaces stay dark until their downstream implementations are complete. */
export function getAgentFeatureFlags(env: Record<string, string | undefined> = process.env): AgentFeatureFlags {
  return {
    propagationEnabled: optionalBooleanFlag("ORCA_M6_PROPAGATION_ENABLED", env.ORCA_M6_PROPAGATION_ENABLED),
    mcpEnabled: optionalBooleanFlag("ORCA_M6_MCP_ENABLED", env.ORCA_M6_MCP_ENABLED),
  };
}
