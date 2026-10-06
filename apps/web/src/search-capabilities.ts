import { authSessionSchema } from "@orca/shared/schemas";
import { mailSearchCapabilitiesSchema, type MailSearchCapabilities } from "@orca/shared/mail-search";

export type ClientSearchCapabilities = MailSearchCapabilities & { verified: boolean };
export class SearchCapabilityError extends Error {
  readonly code = "search_capability_unavailable";
}
// Scoped to the current application session, authenticated owner and origin.
// A later old replica/error must not downgrade an owner already seen indexed.
const observedIndexed = new Set<string>();
const ownerKey = (ownerId: string) => `${window.location.origin}:${ownerId}`;

export async function resolveSearchCapabilities(signal?: AbortSignal): Promise<ClientSearchCapabilities> {
  const response = await fetch("/v1/mail/search/capabilities", { credentials: "include", cache: "no-store", signal });
  if (response.status === 404) {
    const sessionResponse = await fetch("/v1/auth/session", { credentials: "include", cache: "no-store", signal });
    if (!sessionResponse.ok) throw new SearchCapabilityError("Search availability could not be checked. Please sign in or retry.");
    const session = authSessionSchema.parse(await sessionResponse.json());
    if (!session.isAuthenticated || !session.user) throw new SearchCapabilityError("Sign in to search stored mail.");
    if (observedIndexed.has(ownerKey(session.user.id))) throw new SearchCapabilityError("This server cannot confirm the active indexed search mode. Retry without changing your query.");
    return { version: 1, mode: "legacy-metadata", epoch: "legacy-server", ownerId: session.user.id,
      coverage: "stored-metadata", semantics: "legacy-substring-v1", verified: false };
  }
  if (!response.ok) throw new SearchCapabilityError("Search availability could not be checked. Your query and scope are unchanged.");
  const parsed = mailSearchCapabilitiesSchema.safeParse(await response.json());
  if (!parsed.success) throw new SearchCapabilityError("The server returned an unsupported search mode. Please retry.");
  if (signal?.aborted) throw new DOMException("Search cancelled", "AbortError");
  if (parsed.data.mode === "indexed") observedIndexed.add(ownerKey(parsed.data.ownerId));
  return { ...parsed.data, verified: true };
}

export function expectedSearchHeaders(capabilities: ClientSearchCapabilities | null): Record<string, string> | undefined {
  return capabilities ? { "X-Orca-Expected-Search-Mode": capabilities.mode, "X-Orca-Expected-Search-Epoch": capabilities.epoch } : undefined;
}
export function searchResponseMatchesMode(response: Response, capabilities: ClientSearchCapabilities | null): boolean {
  if (!capabilities) return true;
  const mode = response.headers.get("X-Orca-Search-Mode");
  const epoch = response.headers.get("X-Orca-Search-Epoch");
  if (!capabilities.verified && mode === null && epoch === null) return true; // Explicit old-server compatibility only.
  return mode === capabilities.mode && epoch === capabilities.epoch;
}
