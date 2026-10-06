/** Narrowing helpers for loosely typed JSON fields (ledger event data, isolation details). */
import type { JsonValue } from "./api";

/** A finite number, or null. */
export function asNumber(v: JsonValue | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A string, or null. */
export function asString(v: JsonValue | undefined): string | null {
  return typeof v === "string" ? v : null;
}

/** The string items of an array (anything else is dropped). */
export function asStringList(v: JsonValue | undefined): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
