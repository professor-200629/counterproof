import { ChevronRight } from "lucide-react";
import type { ReactNode, SyntheticEvent } from "react";
import { cn } from "@/lib/cn";

export interface DisclosureProps {
  summary: ReactNode;
  children: ReactNode;
  /** Start open. */
  defaultOpen?: boolean;
  /** Bordered box (default) or a bare inline toggle. */
  bare?: boolean;
  className?: string;
  bodyClassName?: string;
  onToggle?: (e: SyntheticEvent<HTMLDetailsElement>) => void;
}

/**
 * Native <details> with a visible chevron (keyboard: Tab to the summary, Enter/Space
 * toggles). The chevron rotates only for its own <details>, so nesting is safe.
 */
export function Disclosure({ summary, children, defaultOpen, bare, className, bodyClassName, onToggle }: DisclosureProps) {
  return (
    <details open={defaultOpen} onToggle={onToggle} className={cn(!bare && "rounded-md border border-line bg-surface", className)}>
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center gap-1.5 rounded-md text-sm text-fg [&::-webkit-details-marker]:hidden",
          bare ? "py-1" : "px-3 py-2 hover:bg-raised/60",
        )}
      >
        <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-subtle transition-transform [details[open]>summary>&]:rotate-90" />
        <span className="min-w-0">{summary}</span>
      </summary>
      <div className={cn(!bare && "border-t border-line p-3", bare && "pt-2", bodyClassName)}>{children}</div>
    </details>
  );
}
