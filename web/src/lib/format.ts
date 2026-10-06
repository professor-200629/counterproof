/** Pure formatting helpers (no React, safe on server and client). */

/** "0x1234567890abcdef" -> "0x1234…cdef". Returns the input unchanged when already short. */
export function middleTruncate(value: string, head = 10, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** "sha256:abcdef…" keeps the algorithm prefix visible: "sha256:8e1b6aee…6910". */
export function truncateDigest(value: string, head = 8, tail = 6): string {
  const m = /^([a-z0-9]+:)(.*)$/i.exec(value);
  if (!m) return middleTruncate(value, head + 2, tail);
  const [, prefix, rest] = m;
  return rest.length <= head + tail + 1 ? value : `${prefix}${rest.slice(0, head)}…${rest.slice(-tail)}`;
}

/** 0x-address shortened to 0x1234…abcd. */
export function shortAddress(address: string, head = 6, tail = 4): string {
  return middleTruncate(address, head, tail);
}

const numberFmt = new Intl.NumberFormat("en-US");

export function formatNumber(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? numberFmt.format(n) : "n/a";
}

/** Synthetic marketplace amounts (integer SYN units): 26000 -> "26,000 SYN". */
export function formatSyn(amount: number | null | undefined, currency = "SYN"): string {
  return typeof amount === "number" ? `${numberFmt.format(amount)} ${currency}` : "n/a";
}

/** 586 -> "586 ms", 12_400 -> "12.4 s", 125_000 -> "2 min 5 s". */
export function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "n/a";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1).replace(/\.0$/, "")} s`;
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  const rem = total % 60;
  if (m < 60) return rem ? `${m} min ${rem} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

/** Absolute timestamp. `utc: true` gives a stable string for server rendering. */
export function formatUnix(ts: number | null | undefined, opts: { utc?: boolean; seconds?: boolean } = {}): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "n/a";
  const d = new Date(ts * 1000);
  if (opts.utc) {
    const iso = d.toISOString();
    return `${iso.slice(0, 10)} ${iso.slice(11, opts.seconds ? 19 : 16)} UTC`;
  }
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: opts.seconds ? "2-digit" : undefined,
  });
}

export function toIso(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

/**
 * Relative time between a unix-seconds timestamp and `nowMs`:
 * past -> "3 min ago", future -> "in 52 min", |delta| < 5 s -> "just now".
 */
export function formatRelative(ts: number, nowMs: number): string {
  const delta = Math.round(ts - nowMs / 1000);
  const abs = Math.abs(delta);
  if (abs < 5) return "just now";
  let text: string;
  if (abs < 60) text = `${abs} s`;
  else if (abs < 3600) text = `${Math.floor(abs / 60)} min`;
  else if (abs < 86400) {
    const h = Math.floor(abs / 3600);
    const m = Math.floor((abs % 3600) / 60);
    text = m && h < 10 ? `${h} h ${m} min` : `${h} h`;
  } else text = `${Math.floor(abs / 86400)} d`;
  return delta > 0 ? `in ${text}` : `${text} ago`;
}

/** Countdown text "1 h 02 min 05 s" (or "0 s"). */
export function formatCountdown(secondsLeft: number): string {
  const s = Math.max(0, Math.floor(secondsLeft));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d) return `${d} d ${h} h ${pad(m)} min`;
  if (h) return `${h} h ${pad(m)} min ${pad(sec)} s`;
  if (m) return `${m} min ${pad(sec)} s`;
  return `${sec} s`;
}

/** "1 rule" / "3 rules"; pass `many` for irregular plurals ("entry", "entries"). */
export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/** 9_555_968 -> "9.1 MiB". */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "n/a";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Case-insensitive comparison of two hex strings (addresses, hashes, bytes32). Null when
 * either side is missing, so "could not compare" is never shown as a match or a mismatch.
 */
export function sameHex(a: string | null | undefined, b: string | null | undefined): boolean | null {
  if (!a || !b) return null;
  return a.toLowerCase() === b.toLowerCase();
}
