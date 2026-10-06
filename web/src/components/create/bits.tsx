/** Small presentational pieces used only by the create-challenge wizard. */
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** A titled block inside a step (h3 + optional description). */
export function Block({
  title,
  description,
  children,
  className,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
  actions?: ReactNode;
}) {
  return (
    <div className={cn("min-w-0 rounded-lg border border-line bg-surface", className)}>
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-fg">{title}</h3>
          {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      <div className="space-y-3 px-4 py-4 sm:px-5">{children}</div>
    </div>
  );
}

/** Inline "updating" note shown while the backend preview catches up. No spinner. */
export function UpdatingNote({ show, className }: { show: boolean; className?: string }) {
  if (!show) return null;
  return (
    <span role="status" className={cn("text-xs text-muted", className)}>
      Updating from the backend preview...
    </span>
  );
}
