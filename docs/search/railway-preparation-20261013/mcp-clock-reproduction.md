# Deterministic MCP fixture clock reproduction — 2026-10-13

Application files were not modified. `reproduce-mcp-clock.ts` copies the existing fixture from `apps/api/src/agents/mcp-cost-budgets.test.ts`, uses each immutable checkout's real authorization schema/handler/limiter, and replaces only the fixture's separate date reads with one captured timestamp plus an injected 0 or 1 millisecond interval. The original fixture creates `issuedAt: new Date()` followed by `expiresAt: new Date(Date.now() + 600_000)`; crossing a millisecond produces a lifetime greater than the schema's strict 600-second maximum.

Ran Bun 1.3.14 against main `0e6805131a9c8386107bf70f598e2b61b0cf6a0b` and integration `fdc78bce2d4e3169f870aaaffd62da20d9f46f30`. Both produce identical observations, and both fixture source hashes are `f6e997d8386af0d0b3556d90d69c328704dcc2b3f8e5da0b92f85cfe8b9bd709`.

| Injected interval | Token lifetime | Missing-name response | Limiter connections | Next valid request |
| --- | --- | --- | --- | --- |
| 0 ms | 600,000 ms | HTTP 200, SDK validation error -32602 | 1 | HTTP 429 |
| 1 ms | 600,001 ms | HTTP 500, server_error | 0 | HTTP 200 |
| 0 ms (restored) | 600,000 ms | HTTP 200, SDK validation error -32602 | 1 | HTTP 429 |

The schema throws inside the test verifier before `requestLimiter.acquire`; the handler maps the unexpected validation error through `bearerAuthChallengeResponse` to HTTP 500. The original assertion only searches for an `"error"` property, so both the intended SDK error and the unintended server error pass that first assertion. The subsequent connections assertion then fails with 0 versus 1.

This establishes a deterministic pre-existing test-fixture defect compatible with the observed suite failure. It does not prove the unrecorded HTTP response or exact timing of the original suite failure. Full integration remains reported as 742 passed/1 failed; full current main as 740 passed; the original file passes in isolation on both. No unrelated source fix or security-bound relaxation was made.

Reproduce:

```sh
/workspace/.orca-tools/node_modules/.bin/bun /workspace/pr235-evidence/oct13/reproduce-mcp-clock.ts /workspace/pr235-main-20261013
/workspace/.orca-tools/node_modules/.bin/bun /workspace/pr235-evidence/oct13/reproduce-mcp-clock.ts /workspace/pr235-integration-20261013
```

Raw evidence: `mcp-clock-main.json`, `mcp-clock-integration.json`. Six total synthetic requests per checkout; no real credentials, mail, or infrastructure access.
