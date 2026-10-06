"use client";

import { useNow } from "@/components/ui/time";
import { cn } from "@/lib/cn";
import { formatCountdown, formatRelative, formatUnix, toIso } from "@/lib/format";

const WORDS = {
  submission: { label: "Submissions", future: "close in", past: "closed", ssr: "close" },
  settlement: { label: "Settlement deadline", future: "in", past: "passed", ssr: "" },
} as const;

export interface DeadlineProps {
  kind: keyof typeof WORDS;
  /** Unix seconds. */
  to: number | null | undefined;
  /** No amber "under one hour" emphasis (e.g. the challenge is already settled or refunded). */
  quiet?: boolean;
  className?: string;
}

/**
 * One deadline as a sentence: "Submissions close in 52 min 10 s" / "Submissions closed 3 h ago",
 * "Settlement deadline in 1 h 52 min" / "Settlement deadline passed 2 h ago". The exact UTC
 * time is in the tooltip; SSR renders the absolute time so hydration matches.
 */
export function Deadline({ kind, to, quiet = false, className }: DeadlineProps) {
  const now = useNow(1000);
  const w = WORDS[kind];
  if (typeof to !== "number") {
    return <span className={cn("block text-subtle", className)}>{w.label}: not set</span>;
  }
  let text: string;
  let tone = "text-muted";
  if (now === null) {
    text = `${w.label} ${w.ssr ? `${w.ssr} ` : ""}${formatUnix(to, { utc: true })}`;
  } else {
    const left = to - now / 1000;
    if (left > 0) {
      text = `${w.label} ${w.future} ${formatCountdown(left)}`;
      tone = !quiet && left < 3600 ? "text-warn" : "text-fg";
    } else {
      text = `${w.label} ${w.past} ${formatRelative(to, now)}`;
    }
  }
  return (
    <time dateTime={toIso(to)} title={formatUnix(to, { utc: true, seconds: true })} className={cn("block tabular", tone, className)}>
      {text}
    </time>
  );
}

/** Both deadlines of a challenge, stacked. */
export function Deadlines({
  submission,
  settlement,
  quiet,
  className,
}: {
  submission: number | null | undefined;
  settlement: number | null | undefined;
  quiet?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("space-y-0.5 text-xs", className)}>
      <Deadline kind="submission" to={submission} quiet={quiet} />
      <Deadline kind="settlement" to={settlement} quiet={quiet} />
    </div>
  );
}
