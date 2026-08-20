import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { getAgentFeatureFlags } from "./config.ts";

describe("M6 agent feature flags", () => {
  test("keeps propagation and MCP off by default for backward compatibility", () => {
    assert.deepEqual(getAgentFeatureFlags({}), {
      propagationEnabled: false,
      mcpEnabled: false,
    });
  });

  test("enables each additive surface independently", () => {
    assert.deepEqual(getAgentFeatureFlags({
      ORCA_M6_PROPAGATION_ENABLED: "true",
      ORCA_M6_MCP_ENABLED: "1",
    }), {
      propagationEnabled: true,
      mcpEnabled: true,
    });
  });

  test("rejects ambiguous flag values", () => {
    assert.throws(
      () => getAgentFeatureFlags({ ORCA_M6_MCP_ENABLED: "sometimes" }),
      /ORCA_M6_MCP_ENABLED/,
    );
  });
});
