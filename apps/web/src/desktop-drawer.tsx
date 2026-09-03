import type { ReactNode } from "react";
import { TopLayer } from "./top-layer";

export function DesktopDrawer({ ariaLabel, backdropClassName = "desktop-transient-backdrop", children, className = "", layerClassName = "desktop-transient-layer", onClose }: {
  ariaLabel: string;
  backdropClassName?: string;
  children: ReactNode;
  className?: string;
  layerClassName?: string;
  onClose: () => void;
}) {
  return <TopLayer
    ariaLabel={ariaLabel}
    backdropClassName={backdropClassName}
    className={className}
    layerClassName={layerClassName}
    onClose={onClose}
  >{children}</TopLayer>;
}
