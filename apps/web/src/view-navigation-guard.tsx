import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import "./view-navigation-guard.css";

type Guard = { blocked: () => boolean; request: (leave: () => void) => void };
const guards = new WeakMap<Window, Guard>();

/** All navigation intentions run here before changing selection, URL, or editor state. */
export function requestViewNavigation(leave: () => void, browser: Window = window) {
  const guard = guards.get(browser);
  if (guard?.blocked()) guard.request(leave);
  else leave();
}

const positionKey = "__orcaViewNavigationPosition";
/** Track entries without replacing the mail/search metadata. Roll a blocked traversal
 * back before asking, then replay its exact delta once after Discard. */
export function installViewNavigationHistory(browser: Window) {
  const history = browser.history;
  const push = history.pushState;
  const replace = history.replaceState;
  let position = Number(history.state?.[positionKey] ?? 0);
  let restoring: (() => void) | null = null;
  let replay = false;
  replace.call(history, { ...history.state, [positionKey]: position }, "");
  history.pushState = function (state, unused, url) {
    push.call(history, { ...state, [positionKey]: position + 1 }, unused, url);
    position += 1;
  };
  history.replaceState = function (state, unused, url) {
    replace.call(history, { ...state, [positionKey]: position }, unused, url);
  };
  const pop = (event: PopStateEvent) => {
    const next = event.state?.[positionKey];
    if (restoring) {
      event.stopImmediatePropagation();
      const done = restoring; restoring = null; done(); return;
    }
    if (replay || !guards.get(browser)?.blocked() || typeof next !== "number") {
      replay = false;
      if (typeof next === "number") position = next;
      return;
    }
    const delta = next - position;
    if (!delta) return;
    event.stopImmediatePropagation();
    restoring = () => requestViewNavigation(() => { replay = true; history.go(delta); }, browser);
    history.go(-delta);
  };
  browser.addEventListener("popstate", pop, true);
  return () => {
    browser.removeEventListener("popstate", pop, true);
    history.pushState = push; history.replaceState = replace;
  };
}

export function useViewNavigationGuard({ dirty, saving, editor }: { dirty: boolean; saving: boolean; editor: RefObject<HTMLElement | null> }) {
  const latest = useRef({ dirty, saving }); latest.current = { dirty, saving };
  const pending = useRef<(() => void) | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const lastEditorFocus = useRef<HTMLElement | null>(null);
  const [asking, setAsking] = useState(false);
  const released = useRef(false);
  useLayoutEffect(() => { if (!dirty && !saving) released.current = false; }, [dirty, saving]);
  const blocked = () => !released.current && (latest.current.dirty || latest.current.saving);
  const ask = (leave: () => void) => {
    if (latest.current.saving || pending.current) return;
    const active = document.activeElement as HTMLElement | null;
    returnFocus.current = active && editor.current?.contains(active) ? active : lastEditorFocus.current;
    pending.current = leave; setAsking(true);
  };
  const askRef = useRef(ask); askRef.current = ask;
  useLayoutEffect(() => {
    const guard: Guard = { blocked, request: leave => askRef.current(leave) };
    guards.set(window, guard);
    const focus = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && editor.current?.contains(event.target) && !event.target.closest("dialog")) lastEditorFocus.current = event.target;
    };
    const unload = (event: BeforeUnloadEvent) => { if (blocked()) { event.preventDefault(); event.returnValue = ""; } };
    const link = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!blocked() || !(anchor instanceof window.HTMLAnchorElement) || anchor.target === "_blank" || anchor.hasAttribute("download") || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); event.stopPropagation();
      askRef.current(() => window.location.assign(anchor.href));
    };
    document.addEventListener("focusin", focus);
    document.addEventListener("click", link, true);
    window.addEventListener("beforeunload", unload);
    return () => {
      if (guards.get(window) === guard) guards.delete(window);
      document.removeEventListener("focusin", focus); document.removeEventListener("click", link, true);
      window.removeEventListener("beforeunload", unload);
    };
  }, []);
  const keep = () => {
    pending.current = null; setAsking(false);
    window.setTimeout(() => returnFocus.current?.isConnected && returnFocus.current.focus({ preventScroll: true }), 0);
  };
  const discard = () => {
    if (latest.current.saving) return;
    const leave = pending.current; pending.current = null; setAsking(false);
    released.current = true;
    leave?.();
    // Stay released until the old draft clears: full-page navigation may dispatch
    // beforeunload after this event, and must not ask for a second confirmation.
  };
  return { asking, keep, discard, request: (leave: () => void) => blocked() ? ask(leave) : leave(), release: () => { released.current = true; } };
}

export function ViewDiscardDialog({ onKeep, onDiscard }: { onKeep: () => void; onDiscard: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (dialog?.showModal) dialog.showModal();
    else dialog?.setAttribute("open", "");
    dialog?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    return () => dialog?.close?.();
  }, []);
  return <dialog aria-label="Discard changes to this draft?" className="view-navigation-dialog" ref={ref} onCancel={event => { event.preventDefault(); onKeep(); }}>
    <h2>Discard changes to this draft?</h2><p>Your saved View, source and mail stay unchanged.</p>
    <div><button className="view-action view-discard-keep" onClick={onKeep} type="button">Keep editing</button><button className="view-action" onClick={onDiscard} type="button">Discard draft</button></div>
  </dialog>;
}
