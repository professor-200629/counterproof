import { cn } from "@/lib/cn";

export interface ReasonListProps {
  /** Why an action is not available yet, in plain words. Empty = nothing is blocking. */
  reasons: string[];
  /** Accessible name of the list. */
  label?: string;
  className?: string;
}

/**
 * Bulleted list of the reasons an action is blocked (amber: waiting on something), announced
 * politely. Shown next to the disabled control so a disabled button is never unexplained.
 */
export function ReasonList({ reasons, label = "Why this is not available yet", className }: ReasonListProps) {
  if (reasons.length === 0) return null;
  return (
    <ul role="status" aria-live="polite" aria-label={label} className={cn("space-y-0.5 text-xs text-warn", className)}>
      {reasons.map((r) => (
        <li key={r} className="flex gap-1.5">
          <span aria-hidden="true">-</span>
          <span>{r}</span>
        </li>
      ))}
    </ul>
  );
}
