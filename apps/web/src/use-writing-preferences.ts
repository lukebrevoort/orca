import { useEffect, useState } from "react";
import type { MailAccount } from "@orca/shared";
import { defaultWritingPreferences, loadWritingPreferences, type WritingPreferenceState } from "./writing-preferences";

const changedEvent = "orca-writing-preferences-changed";

/** Call only after Settings successfully saves. No preference values travel in
 * the event: each consumer fetches preferences from the current session.
 */
export function invalidateWritingPreferences() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(changedEvent));
}

/** Supply only the currently authorized account from /v1/me, /v1/accounts or
 * an authorized thread response. Pass null while authorization is unresolved.
 */
export function useWritingPreferences(account: MailAccount | null, demoMode = false): WritingPreferenceState {
  const accountId = account?.id ?? null;
  const [state, setState] = useState<WritingPreferenceState>({ accountId: null, status: "loading", preferences: defaultWritingPreferences });
  useEffect(() => {
    if (!account || demoMode) {
      setState({ accountId: null, status: "unavailable", preferences: defaultWritingPreferences });
      return;
    }
    let controller: AbortController | null = null;
    const refresh = () => {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      setState({ accountId, status: "loading", preferences: defaultWritingPreferences });
      void loadWritingPreferences(account, request.signal).then((next) => {
        if (!request.signal.aborted) setState(next);
      });
    };
    refresh();
    window.addEventListener(changedEvent, refresh);
    return () => {
      controller?.abort();
      window.removeEventListener(changedEvent, refresh);
    };
  }, [account, demoMode]);
  // Scope protection runs during render, before effect cleanup after switching.
  if (!accountId || demoMode) return { accountId, status: "unavailable", preferences: defaultWritingPreferences };
  if (state.accountId !== accountId) return { accountId, status: "loading", preferences: defaultWritingPreferences };
  return state;
}
