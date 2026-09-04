import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

const focusableSelector = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "[contenteditable=\"true\"]",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

type LayerRecord = {
  dismissible: () => boolean;
  element: HTMLElement;
  focus: () => void;
  id: string;
  onClose: () => void;
  opener: HTMLElement | null;
  returnFocus: () => HTMLElement | null;
};

type TopLayerManager = {
  activeId: string | null;
  active: boolean;
  register: (record: LayerRecord) => () => void;
};

const TopLayerContext = createContext<TopLayerManager | null>(null);

function visibleFocusableElements(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(focusableSelector)].filter((element) => (
    !element.hidden
    && !element.closest("[hidden]")
    && element.getAttribute("aria-hidden") !== "true"
    && !element.closest("[inert]")
  ));
}

function isEditableTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    && target.matches('input, textarea, select, [contenteditable="true"], [role="textbox"]');
}

function canRestoreFocus(element: HTMLElement | null | undefined) {
  if (
    !element
    || element === document.body
    || element === document.documentElement
    || !element.isConnected
    || element.matches(":disabled, [aria-disabled=true]")
  ) return false;

  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.hidden || current.inert || current.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
  }
  return true;
}

function firstBackgroundFocusTarget() {
  const portalRoot = document.getElementById("orca-top-layer-root");
  return [...document.body.querySelectorAll<HTMLElement>(focusableSelector)].find((element) => (
    !portalRoot?.contains(element) && canRestoreFocus(element)
  )) ?? null;
}

function ensurePortalRoot() {
  if (typeof document === "undefined") return null;
  const existing = document.getElementById("orca-top-layer-root");
  if (existing) return existing;
  const root = document.createElement("div");
  root.id = "orca-top-layer-root";
  document.body.append(root);
  return root;
}

export function TopLayerProvider({ children }: { children: ReactNode }) {
  const stackRef = useRef<LayerRecord[]>([]);
  const backgroundStateRef = useRef(new Map<Element, { ariaHidden: string | null; inert: boolean }>());
  const restoreFrameRef = useRef<number | null>(null);
  const rootReturnFocusRef = useRef<HTMLElement | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const setBackgroundBlocked = useCallback((blocked: boolean) => {
    if (typeof document === "undefined") return;
    const portalRoot = ensurePortalRoot();
    if (blocked) {
      for (const element of [...document.body.children]) {
        if (element === portalRoot || backgroundStateRef.current.has(element)) continue;
        backgroundStateRef.current.set(element, {
          ariaHidden: element.getAttribute("aria-hidden"),
          inert: element instanceof HTMLElement ? element.inert : false,
        });
        element.setAttribute("aria-hidden", "true");
        if (element instanceof HTMLElement) element.inert = true;
      }
      return;
    }
    for (const [element, previous] of backgroundStateRef.current) {
      if (previous.ariaHidden === null) element.removeAttribute("aria-hidden");
      else element.setAttribute("aria-hidden", previous.ariaHidden);
      if (element instanceof HTMLElement) element.inert = previous.inert;
    }
    backgroundStateRef.current.clear();
  }, []);

  const register = useCallback((record: LayerRecord) => {
    if (restoreFrameRef.current !== null) {
      window.cancelAnimationFrame(restoreFrameRef.current);
      restoreFrameRef.current = null;
    }
    const previousTop = stackRef.current.at(-1);
    if (!previousTop) {
      rootReturnFocusRef.current = canRestoreFocus(record.opener) ? record.opener : record.returnFocus();
    }
    previousTop?.element.parentElement?.setAttribute("aria-hidden", "true");
    if (previousTop?.element.parentElement instanceof HTMLElement) previousTop.element.parentElement.inert = true;
    stackRef.current = [...stackRef.current, record];
    record.element.parentElement?.removeAttribute("aria-hidden");
    if (record.element.parentElement instanceof HTMLElement) record.element.parentElement.inert = false;
    setBackgroundBlocked(true);
    setActiveId(record.id);
    record.focus();

    return () => {
      const stack = stackRef.current;
      const index = stack.findIndex((candidate) => candidate.id === record.id);
      if (index < 0) return;
      const wasTop = index === stack.length - 1;
      stackRef.current = stack.filter((candidate) => candidate.id !== record.id);
      const nextTop = stackRef.current.at(-1) ?? null;
      nextTop?.element.parentElement?.removeAttribute("aria-hidden");
      if (nextTop?.element.parentElement instanceof HTMLElement) nextTop.element.parentElement.inert = false;
      setActiveId(nextTop?.id ?? null);
      if (!stackRef.current.length) setBackgroundBlocked(false);
      if (!wasTop) return;
      if (restoreFrameRef.current !== null) {
        window.cancelAnimationFrame(restoreFrameRef.current);
        restoreFrameRef.current = null;
      }
      const rootReturnFocus = rootReturnFocusRef.current;
      if (!nextTop) rootReturnFocusRef.current = null;
      restoreFrameRef.current = window.requestAnimationFrame(() => {
        restoreFrameRef.current = null;
        const candidates = nextTop
          ? [record.opener, record.returnFocus()]
          : [record.opener, record.returnFocus(), rootReturnFocus, firstBackgroundFocusTarget()];
        for (const candidate of candidates) {
          if (!canRestoreFocus(candidate)) continue;
          candidate!.focus({ preventScroll: true });
          return;
        }
        if (nextTop && stackRef.current.some((candidate) => candidate.id === nextTop.id)) nextTop.focus();
      });
    };
  }, [setBackgroundBlocked]);

  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const top = stackRef.current.at(-1);
      if (!top) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (top.dismissible()) top.onClose();
        return;
      }

      const commandSearch = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      const unmodifiedAppKey = event.key.length === 1
        && event.key !== " "
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
        && !isEditableTarget(event.target);
      if (commandSearch || unmodifiedAppKey) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        return;
      }

      if (event.key !== "Tab") return;
      const focusable = visibleFocusableElements(top.element);
      if (!focusable.length) {
        event.preventDefault();
        top.element.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (!(document.activeElement instanceof HTMLElement) || !focusable.includes(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      if (restoreFrameRef.current !== null) window.cancelAnimationFrame(restoreFrameRef.current);
      setBackgroundBlocked(false);
      stackRef.current = [];
    };
  }, [setBackgroundBlocked]);

  const value = useMemo<TopLayerManager>(() => ({ active: activeId !== null, activeId, register }), [activeId, register]);
  return <TopLayerContext.Provider value={value}>{children}</TopLayerContext.Provider>;
}

export function useTopLayerActive() {
  return useContext(TopLayerContext)?.active ?? false;
}

type AccessibleName =
  | { ariaLabel: string; ariaLabelledBy?: never }
  | { ariaLabel?: never; ariaLabelledBy: string };

type TopLayerProps = AccessibleName & {
  ariaBusy?: boolean;
  ariaDescribedBy?: string;
  as?: "aside" | "div" | "section";
  backdrop?: boolean;
  backdropAccessible?: boolean;
  backdropAriaLabel?: string;
  backdropClassName?: string;
  children: ReactNode;
  className?: string;
  dismissible?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  initialFocusSelector?: string;
  layerClassName?: string;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  surfaceProps?: HTMLAttributes<HTMLElement>;
  style?: CSSProperties;
};

export function TopLayer({
  ariaBusy,
  ariaDescribedBy,
  ariaLabel,
  ariaLabelledBy,
  as = "div",
  backdrop = true,
  backdropAccessible = true,
  backdropAriaLabel,
  backdropClassName = "",
  children,
  className = "",
  dismissible = true,
  initialFocusRef,
  initialFocusSelector,
  layerClassName = "",
  onClose,
  returnFocusRef,
  surfaceProps,
  style,
}: TopLayerProps) {
  const manager = useContext(TopLayerContext);
  if (!manager) throw new Error("TopLayer must be rendered inside TopLayerProvider.");

  const id = useId();
  const surfaceRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);
  const initialFocusRefRef = useRef(initialFocusRef);
  const initialFocusSelectorRef = useRef(initialFocusSelector);
  closeRef.current = onClose;
  dismissibleRef.current = dismissible;
  initialFocusRefRef.current = initialFocusRef;
  initialFocusSelectorRef.current = initialFocusSelector;

  useLayoutEffect(() => {
    const element = surfaceRef.current;
    if (!element) return;
    openerRef.current ??= document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return manager.register({
      dismissible: () => dismissibleRef.current,
      element,
      focus: () => {
        const preferred = initialFocusRefRef.current?.current
          ?? (initialFocusSelectorRef.current ? element.querySelector<HTMLElement>(initialFocusSelectorRef.current) : null)
          ?? element.querySelector<HTMLElement>("[data-dialog-initial-focus]")
          ?? visibleFocusableElements(element)[0]
          ?? element;
        if (preferred.isConnected) preferred.focus({ preventScroll: true });
      },
      id,
      onClose: () => closeRef.current(),
      opener: openerRef.current,
      returnFocus: () => returnFocusRef?.current ?? null,
    });
  }, [id, manager.register]);

  const isTop = manager.activeId === id;
  const layer = (
    <div
      aria-hidden={isTop ? undefined : "true"}
      className={`orca-top-layer ${layerClassName}`.trim()}
      data-top-layer={isTop ? "active" : "background"}
      inert={isTop ? undefined : true}
      role="presentation"
    >
      {backdrop ? <button
        aria-hidden={backdropAccessible ? undefined : "true"}
        aria-label={backdropAccessible ? backdropAriaLabel ?? `Close ${ariaLabel ?? "dialog"}` : undefined}
        className={backdropClassName}
        disabled={!dismissible}
        onClick={dismissible ? onClose : undefined}
        tabIndex={-1}
        type="button"
      /> : null}
      {createElement(as, {
        ...surfaceProps,
        "aria-busy": ariaBusy || undefined,
        "aria-describedby": ariaDescribedBy,
        "aria-label": ariaLabel,
        "aria-labelledby": ariaLabelledBy,
        "aria-modal": "true",
        className,
        ref: surfaceRef,
        role: "dialog",
        style,
        tabIndex: -1,
      }, children)}
    </div>
  );
  const portalRoot = ensurePortalRoot();
  return portalRoot ? createPortal(layer, portalRoot) : layer;
}
