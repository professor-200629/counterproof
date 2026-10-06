import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { toneText, type Tone } from "./tone";

export interface StatGridProps {
  children: ReactNode;
  /** Columns at the widest breakpoint (2-6). Collapses to 2 on phones. */
  columns?: 2 | 3 | 4 | 5 | 6;
  className?: string;
}

const cols: Record<NonNullable<StatGridProps["columns"]>, string> = {
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
  5: "sm:grid-cols-3 lg:grid-cols-5",
  6: "sm:grid-cols-3 lg:grid-cols-6",
};

/** A <dl> grid of Stat items. */
export function StatGrid({ children, columns = 4, className }: StatGridProps) {
  return <dl className={cn("grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line", cols[columns], className)}>{children}</dl>;
}

export interface StatProps {
  label: ReactNode;
  value: ReactNode;
  /** Secondary line under the value (units, context, source). */
  hint?: ReactNode;
  tone?: Tone;
  /** Render the value in the mono font (digests, counts that must align). */
  mono?: boolean;
  className?: string;
}

/** One labelled figure. Use inside StatGrid (renders dt/dd). Values must be real numbers from the API. */
export function Stat({ label, value, hint, tone, mono, className }: StatProps) {
  return (
    <div className={cn("min-w-0 bg-surface px-4 py-3", className)}>
      <dt className="text-xs font-medium text-muted">{label}</dt>
      {/* One text colour only: with both text-fg and a tone class, CSS order (not intent) would pick the winner. */}
      <dd className={cn("mt-1 text-lg font-semibold tabular", tone ? toneText[tone] : "text-fg", mono && "font-mono text-base")}>{value}</dd>
      {hint ? <dd className="mt-0.5 text-xs text-subtle">{hint}</dd> : null}
    </div>
  );
}

export interface KeyValueListProps {
  items: { label: ReactNode; value: ReactNode; key?: string }[];
  className?: string;
}

/** Two-column definition list for dense facts (spec fields, provenance). */
export function KeyValueList({ items, className }: KeyValueListProps) {
  return (
    <dl className={cn("grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[minmax(8rem,auto)_1fr]", className)}>
      {items.map((it, i) => (
        <div key={it.key ?? i} className="contents">
          <dt className="text-muted">{it.label}</dt>
          <dd className="min-w-0 break-words text-fg">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
