import { userPreferencesSchema, type MailAccount, type UserPreferences } from "@orca/shared";

export type WritingPreferences = Pick<UserPreferences, "signature" | "composeFormat" | "replyBehavior">;
export const defaultWritingPreferences: Readonly<WritingPreferences> = Object.freeze({
  signature: "", composeFormat: "plain", replyBehavior: "reply",
});

export type WritingPreferenceState = {
  accountId: string | null;
  status: "loading" | "ready" | "unavailable";
  preferences: Readonly<WritingPreferences>;
};

/** Preferences belong to the signed-in Orca user, not a provider account.
 * The caller supplies an account from its authenticated account response, never
 * a route/query account ID. The API authorizes the current user on every read.
 * Never cache personal signatures in shared state or browser storage.
 */
export async function loadWritingPreferences(account: MailAccount, signal: AbortSignal): Promise<WritingPreferenceState> {
  const accountId = account.id;
  const read = async (path: string) => {
    const response = await fetch(path, { credentials: "include", cache: "no-store", signal });
    if (!response.ok) throw new Error("Writing preferences unavailable");
    return response.json();
  };
  try {
    if (signal.aborted) throw new Error("Writing preference request cancelled");
    const { signature, composeFormat, replyBehavior } = userPreferencesSchema.parse(await read("/v1/preferences"));
    if (signal.aborted) throw new Error("Writing preference request cancelled");
    return { accountId, status: "ready", preferences: { signature, composeFormat, replyBehavior } };
  } catch {
    return { accountId, status: "unavailable", preferences: defaultWritingPreferences };
  }
}

type WritingDraft = {
  accountId: string;
  body: string;
  composeFormat?: WritingPreferences["composeFormat"];
  writingPreferencesApplied?: boolean;
};

/** Call only after recovery has finished. isNew is provenance, not emptiness:
 * an empty recovered draft is still recovered. hasEdits includes typing then
 * deleting, recipient/subject changes, attachments, and explicit format changes.
 * Persist the returned marker with the draft; settings updates affect the next
 * draft, including when the user removed their previously inserted signature.
 */
export function initializeWritingDraft<T extends WritingDraft>(
  draft: T,
  state: WritingPreferenceState,
  lifecycle: { isNew: boolean; isHydrated: boolean; hasEdits: boolean },
): T {
  if (!lifecycle.isNew || !lifecycle.isHydrated || lifecycle.hasEdits || draft.writingPreferencesApplied
    || state.accountId !== draft.accountId || state.status === "loading") return draft;
  const preferences = state.status === "ready" ? state.preferences : defaultWritingPreferences;
  const signature = preferences.signature.trim();
  return {
    ...draft,
    // Seed content (e.g. a forwarded message) belongs after the new sign-off.
    body: signature ? `\n\n${signature}${draft.body ? `\n\n${draft.body}` : ""}` : draft.body,
    composeFormat: preferences.composeFormat,
    writingPreferencesApplied: true,
  };
}

export function resolveWritingReplyAction(
  requested: "primary" | "reply" | "reply_all" | "forward",
  accountId: string,
  state: WritingPreferenceState,
): "reply" | "reply_all" | "forward" {
  if (requested !== "primary") return requested;
  return state.accountId === accountId && state.status === "ready" ? state.preferences.replyBehavior : "reply";
}

/** Use the existing escaped Markdown renderer for rich drafts at both save
 * and send boundaries. Missing format means a legacy draft (historically rich).
 */
export function serializeWritingBody(
  body: string,
  format: WritingPreferences["composeFormat"] | undefined,
  renderRich: (body: string) => string,
): { text: string; html: string | null } {
  return { text: body, html: format !== "plain" && body.trim() ? renderRich(body) : null };
}
