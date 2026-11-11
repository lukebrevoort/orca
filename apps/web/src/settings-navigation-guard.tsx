import { useLayoutEffect, type RefObject } from "react";
import { installViewNavigationHistory, useViewNavigationGuard } from "./view-navigation-guard";
import { TopLayer } from "./top-layer";

/** Settings owns a full-page route, so install history tracking while it is mounted. */
export function useSettingsNavigationGuard(dirty: boolean, editor: RefObject<HTMLElement | null>, onDiscard: () => void) {
  useLayoutEffect(() => installViewNavigationHistory(window), []);
  return useViewNavigationGuard({ dirty, saving: false, editor, onDiscard, allowSectionLinks: true });
}

export function SettingsLeaveDialog({ onStay, onLeave }: { onStay: () => void; onLeave: () => void }) {
  return <TopLayer ariaLabel="Leave without saving account choices?" className="settings-leave-dialog" initialFocusSelector="button" onClose={onStay}>
    <h2>Leave without saving account choices?</h2>
    <p>Your writing and reminder choices have unsaved changes. Stay to keep editing or save them before leaving.</p>
    <div><button onClick={onStay} type="button">Stay in Settings</button><button onClick={onLeave} type="button">Leave without saving</button></div>
  </TopLayer>;
}
