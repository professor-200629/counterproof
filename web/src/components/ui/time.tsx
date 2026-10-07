"use client";

import { useSyncExternalStore } from "react";
import { cn } from "@/lib/cn";
import { formatCountdown, formatRelative, formatUnix, toIso } from "@/lib/format";
import { SNAPSHOT_MODE, SNAPSHOT_TAKEN_AT, deadlineAtSnapshot } from "@/lib/snapshot";

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

// Snapshot mode: the clock stands still at the moment the recording was made, so every
// "has the deadline passed / is it expired" judgement describes the recorded state.
const SNAPSHOT_NOW_MS = SNAPSHOT_TAKEN_AT === null ? null : SNAPSHOT_TAKEN_AT * 1000;
const frozenStore = { sub: () => () => {}, snap: () => SNAPSHOT_NOW_MS as number };

/**
 * Current time in ms, re-rendering every `intervalMs`. Null during SSR / hydration. In
 * snapshot mode it is the time the snapshot was taken and never ticks.
 */
export function useNow(intervalMs = 1000): number | null {
  const s = SNAPSHOT_NOW_MS === null ? storeFor(intervalMs) : frozenStore;
  return useSyncExternalStore(s.sub, s.snap, serverSnapshot);
}

export interface TimeProps {
  /** Unix seconds. */
  ts: number | null | undefined;
  className?: string;
  emptyText?: string;
}

/**
 * "3 min ago" / "in 5 min" with the absolute time in a tooltip. In snapshot mode the
 * absolute time instead: "ago" would be measured from a moment the visitor cannot see.
 */
export function TimeAgo({ ts, className, emptyText = "n/a" }: TimeProps) {
  const now = useNow(15_000);
  if (typeof ts !== "number") return <span className={cn("text-subtle", className)}>{emptyText}</span>;
  return (
    <time dateTime={toIso(ts)} title={formatUnix(ts, { utc: true, seconds: true })} className={cn("tabular", className)}>
      {now === null ? formatUnix(ts, { utc: true }) : SNAPSHOT_MODE ? formatUnix(ts) : formatRelative(ts, now)}
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
 * "passed" state afterwards. The exact deadline is in the tooltip. In snapshot mode it does
 * not count: it says whether the deadline had passed when the snapshot was taken.
 */
export function Countdown({ to, expiredText, className, prefix }: CountdownProps) {
  const now = useNow(1000);
  if (typeof to !== "number") return <span className={cn("text-subtle", className)}>n/a</span>;
  const exact = formatUnix(to, { utc: true, seconds: true });
  if (SNAPSHOT_MODE) {
    return (
      <time dateTime={toIso(to)} title={`${exact} - recorded, not counting down`} className={cn("tabular text-muted", className)}>
        {deadlineAtSnapshot(to)}
      </time>
    );
  }
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
