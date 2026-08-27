import { mcpToolErrorSchema, type OrcaMcpToolName } from "@orca/shared";

export const mcpRequestLimits = Object.freeze({
  maximumBodyBytes: 256 * 1_024,
  windowMilliseconds: 60_000,
  maximumConnectionCost: 200,
  maximumWorkspaceCost: 400,
  maximumConnectionInFlight: 4,
  maximumWorkspaceInFlight: 8,
});

export const organizationRouteLimits = Object.freeze({
  maximumBodyBytes: 512 * 1_024,
});

type LimitKeyState = {
  windowStartedAt: number;
  cost: number;
  inFlight: number;
};

export type McpRequestLimiterOptions = {
  now?: () => number;
  windowMilliseconds?: number;
  maximumConnectionCost?: number;
  maximumWorkspaceCost?: number;
  maximumConnectionInFlight?: number;
  maximumWorkspaceInFlight?: number;
};

export type McpRequestLimitDenialReason =
  | "connection_in_flight"
  | "workspace_in_flight"
  | "connection_rate"
  | "workspace_rate";

export type McpRequestLease =
  | { allowed: true; release(): void }
  | { allowed: false; retryAfterSeconds: number; reason: McpRequestLimitDenialReason };

/**
 * Small process-local admission controller. It rejects before tool dispatch,
 * so a rejected request cannot touch approval, idempotency, or Organization
 * mutation state. The two independent buckets keep one connection or
 * Workspace from exhausting unrelated tenants.
 */
export class McpRequestLimiter {
  readonly #now: () => number;
  readonly #windowMilliseconds: number;
  readonly #maximumConnectionCost: number;
  readonly #maximumWorkspaceCost: number;
  readonly #maximumConnectionInFlight: number;
  readonly #maximumWorkspaceInFlight: number;
  readonly #connections = new Map<string, LimitKeyState>();
  readonly #workspaces = new Map<string, LimitKeyState>();

  constructor(options: McpRequestLimiterOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#windowMilliseconds = options.windowMilliseconds ?? mcpRequestLimits.windowMilliseconds;
    this.#maximumConnectionCost = options.maximumConnectionCost ?? mcpRequestLimits.maximumConnectionCost;
    this.#maximumWorkspaceCost = options.maximumWorkspaceCost ?? mcpRequestLimits.maximumWorkspaceCost;
    this.#maximumConnectionInFlight = options.maximumConnectionInFlight ?? mcpRequestLimits.maximumConnectionInFlight;
    this.#maximumWorkspaceInFlight = options.maximumWorkspaceInFlight ?? mcpRequestLimits.maximumWorkspaceInFlight;
  }

  #state(map: Map<string, LimitKeyState>, key: string, now: number): LimitKeyState {
    let state = map.get(key);
    if (!state || now - state.windowStartedAt >= this.#windowMilliseconds) {
      state = { windowStartedAt: now, cost: 0, inFlight: state?.inFlight ?? 0 };
      map.set(key, state);
    }
    return state;
  }

  acquire(input: { connectionId: string; workspaceId: string; cost: number }): McpRequestLease {
    const now = this.#now();
    const connection = this.#state(this.#connections, input.connectionId, now);
    const workspace = this.#state(this.#workspaces, input.workspaceId, now);
    const retryAfterSeconds = Math.max(1, Math.ceil(Math.max(
      connection.windowStartedAt + this.#windowMilliseconds - now,
      workspace.windowStartedAt + this.#windowMilliseconds - now,
    ) / 1_000));
    if (connection.inFlight >= this.#maximumConnectionInFlight) {
      return { allowed: false, retryAfterSeconds, reason: "connection_in_flight" };
    }
    if (workspace.inFlight >= this.#maximumWorkspaceInFlight) {
      return { allowed: false, retryAfterSeconds, reason: "workspace_in_flight" };
    }
    if (connection.cost + input.cost > this.#maximumConnectionCost) {
      return { allowed: false, retryAfterSeconds, reason: "connection_rate" };
    }
    if (workspace.cost + input.cost > this.#maximumWorkspaceCost) {
      return { allowed: false, retryAfterSeconds, reason: "workspace_rate" };
    }
    connection.cost += input.cost;
    workspace.cost += input.cost;
    connection.inFlight += 1;
    workspace.inFlight += 1;
    let released = false;
    return {
      allowed: true,
      release() {
        if (released) return;
        released = true;
        connection.inFlight = Math.max(0, connection.inFlight - 1);
        workspace.inFlight = Math.max(0, workspace.inFlight - 1);
      },
    };
  }
}

export function mcpToolRequestCost(name: string | null): number {
  const costs = {
    describe_organization: 1,
    query_organization: 2,
    simulate_organization: 10,
    apply_organization: 5,
    revert_organization: 5,
    search_mail: 2,
    get_thread: 2,
    list_agent_events: 2,
    get_connection_status: 1,
  } as const satisfies Record<OrcaMcpToolName, number>;
  return name && name in costs ? costs[name as OrcaMcpToolName] : 1;
}

function typedLimitResponse(code: "payload_limit" | "rate_limit", message: string, status: 413 | 429, retryAfterSeconds?: number): Response {
  const headers = new Headers({ "content-type": "application/json; charset=UTF-8" });
  if (retryAfterSeconds !== undefined) headers.set("retry-after", String(retryAfterSeconds));
  return new Response(JSON.stringify(mcpToolErrorSchema.parse({ error: { code, message } })), { status, headers });
}

export function mcpRateLimitResponse(retryAfterSeconds: number): Response {
  return typedLimitResponse("rate_limit", "The bounded Orca MCP request budget is exhausted; retry after the advertised interval", 429, retryAfterSeconds);
}

export type BoundedMcpRequest =
  | { allowed: true; request: Request; body: unknown }
  | { allowed: false; response: Response };

/** Reads no more than maximumBodyBytes + one sentinel byte before OAuth work. */
export async function boundedMcpRequest(request: Request): Promise<BoundedMcpRequest> {
  if (!request.body || !["POST", "PUT", "PATCH"].includes(request.method.toUpperCase())) {
    return { allowed: true, request, body: null };
  }
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > mcpRequestLimits.maximumBodyBytes) {
      await request.body.cancel().catch(() => undefined);
      return { allowed: false, response: typedLimitResponse("payload_limit", "The Orca MCP request body exceeds the 256 KiB limit", 413) };
    }
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > mcpRequestLimits.maximumBodyBytes) {
      await reader.cancel().catch(() => undefined);
      return { allowed: false, response: typedLimitResponse("payload_limit", "The Orca MCP request body exceeds the 256 KiB limit", 413) };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const preserved = new Request(request.url, {
    method: request.method,
    headers,
    body: bytes,
    redirect: request.redirect,
  });
  let body: unknown = null;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    // The MCP SDK owns the stable invalid-JSON response.
  }
  return { allowed: true, request: preserved, body };
}
