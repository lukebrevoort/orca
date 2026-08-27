import { useEffect, useRef, type ReactNode } from "react";

const focusableSelector = 'button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function DesktopDrawer({ ariaLabel, backdropClassName = "desktop-transient-backdrop", children, className = "", layerClassName = "desktop-transient-layer", onClose }: {
  ariaLabel: string;
  backdropClassName?: string;
  children: ReactNode;
  className?: string;
  layerClassName?: string;
  onClose: () => void;
}) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const restoreFrameRef = useRef<number | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (restoreFrameRef.current !== null) {
      window.cancelAnimationFrame(restoreFrameRef.current);
      restoreFrameRef.current = null;
    }
    returnFocusRef.current ??= document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const drawer = drawerRef.current;
    drawer?.querySelector<HTMLElement>(focusableSelector)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !drawer) return;
      const focusable = [...drawer.querySelectorAll<HTMLElement>(focusableSelector)];
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
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
      restoreFrameRef.current = window.requestAnimationFrame(() => {
        const returnFocus = returnFocusRef.current;
        returnFocusRef.current = null;
        restoreFrameRef.current = null;
        returnFocus?.focus();
      });
    };
  }, [onClose]);

  return <div className={layerClassName} role="presentation">
    <button aria-label={`Close ${ariaLabel}`} className={backdropClassName} onClick={onClose} tabIndex={-1} type="button" />
    <div aria-label={ariaLabel} aria-modal="true" className={className} ref={drawerRef} role="dialog">{children}</div>
  </div>;
}
