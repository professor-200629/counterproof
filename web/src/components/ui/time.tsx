"use client";

import { useSyncExternalStore } from "react";
import { cn } from "@/lib/cn";
import { formatCountdown, formatRelative, formatUnix, toIso } from "@/lib/format";

// A shared clock per tick interval. getSnapshot returns a cached number (required by
// useSyncExternalStore); the server snapshot is null so SSR and hydration render the
// same absolute UTC text, then the client switches to relative time.
type Clock = { now: number; listeners: Set<() => void>; timer: ReturnType<typeof setInterval> | null };
const clocks = new Map<number, Clock>();

function clockFor(intervalMs: number): Clock {
  let c = clocks.get(intervalMs);
  if (!c) {
    c = { now: Date.now(), listeners: new Set(), timer: null };
    clocks.set(intervalMs, c);
  }
  return c;
}

function subscribe(intervalMs: number, cb: () => void): () => void {
  const c = clockFor(intervalMs);
  c.listeners.add(cb);
  if (!c.timer) {
    c.now = Date.now();
    c.timer = setInterval(() => {
      c.now = Date.now();
      c.listeners.forEach((l) => l());
    }, intervalMs);
  }
  return () => {
    c.listeners.delete(cb);
    if (c.listeners.size === 0 && c.timer) {
      clearInterval(c.timer);
      c.timer = null;
    }
  };
}

// Stable subscribe / snapshot functions per interval, so React does not resubscribe each render.
const stores = new Map<number, { sub: (cb: () => void) => () => void; snap: () => number }>();
function storeFor(intervalMs: number) {
  let s = stores.get(intervalMs);
  if (!s) {
    s = { sub: (cb) => subscribe(intervalMs, cb), snap: () => clockFor(intervalMs).now };
    stores.set(intervalMs, s);
  }
  return s;
}
const serverSnapshot = () => null;

/** Current time in ms, re-rendering every `intervalMs`. Null during SSR / hydration. */
export function useNow(intervalMs = 1000): number | null {
  const s = storeFor(intervalMs);
  return useSyncExternalStore(s.sub, s.snap, serverSnapshot);
}

export interface TimeProps {
  /** Unix seconds. */
  ts: number | null | undefined;
  className?: string;
  emptyText?: string;
}

/** "3 min ago" / "in 5 min" with the absolute time in a tooltip. */
export function TimeAgo({ ts, className, emptyText = "n/a" }: TimeProps) {
  const now = useNow(15_000);
  if (typeof ts !== "number") return <span className={cn("text-subtle", className)}>{emptyText}</span>;
  return (
    <time dateTime={toIso(ts)} title={formatUnix(ts, { utc: true, seconds: true })} className={cn("tabular", className)}>
      {now === null ? formatUnix(ts, { utc: true }) : formatRelative(ts, now)}
    </time>
  );
}

/** Absolute date and time (UTC on the server, local after hydration). */
export function DateTime({ ts, className, emptyText = "n/a", seconds }: TimeProps & { seconds?: boolean }) {
  const now = useNow(60_000);
  if (typeof ts !== "number") return <span className={cn("text-subtle", className)}>{emptyText}</span>;
  return (
    <time dateTime={toIso(ts)} title={formatUnix(ts, { utc: true, seconds: true })} className={cn("tabular", className)}>
      {now === null ? formatUnix(ts, { utc: true, seconds }) : formatUnix(ts, { seconds })}
    </time>
  );
}

export interface CountdownProps {
  /** Deadline, unix seconds. */
  to: number | null | undefined;
  /** Text once the deadline has passed (default "passed <relative>"). */
  expiredText?: string;
  className?: string;
  /** Prefix such as "Submissions close in". */
  prefix?: string;
}

/**
 * Live countdown to a unix-seconds deadline. Uses amber below one hour and a neutral
 * "passed" state afterwards. The exact deadline is in the tooltip.
 */
export function Countdown({ to, expiredText, className, prefix }: CountdownProps) {
  const now = useNow(1000);
  if (typeof to !== "number") return <span className={cn("text-subtle", className)}>n/a</span>;
  const exact = formatUnix(to, { utc: true, seconds: true });
  if (now === null) {
    return (
      <time dateTime={toIso(to)} title={exact} className={cn("tabular", className)}>
        {prefix ? `${prefix} ` : ""}
        {formatUnix(to, { utc: true })}
      </time>
    );
  }
  const left = to - now / 1000;
  if (left <= 0) {
    return (
      <time dateTime={toIso(to)} title={exact} className={cn("tabular text-muted", className)}>
        {expiredText ?? `passed ${formatRelative(to, now)}`}
      </time>
    );
  }
  return (
    <time
      dateTime={toIso(to)}
      title={exact}
      className={cn("tabular", left < 3600 ? "text-warn" : "text-fg", className)}
    >
      {prefix ? `${prefix} ` : ""}
      {formatCountdown(left)}
    </time>
  );
}
