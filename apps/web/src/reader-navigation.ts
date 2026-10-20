type Bounds = { top: number; bottom: number };
export function readerTargetIsVisible(target: Bounds | null, viewport: Bounds) {
  return target !== null && target.bottom > target.top && target.bottom > viewport.top && target.top < viewport.bottom;
}
export function readerNavigationVisibility(unread: Bounds | null, latest: Bounds | null, viewport: Bounds, movedFromEntry: boolean) {
  if (viewport.bottom <= viewport.top) return { unread: false, latest: false };
  return {
    unread: movedFromEntry && unread !== null && !readerTargetIsVisible(unread, viewport),
    latest: latest !== null && !readerTargetIsVisible(latest, viewport),
  };
}
