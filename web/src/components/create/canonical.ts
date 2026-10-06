/**
 * Recompute a spec digest in the browser, so the publisher does not have to take the
 * backend's word for it. Mirrors backend/counterproof/canonical.py:
 * keys sorted, no whitespace, integers only, UTF-8 (not ASCII-escaped), then SHA-256.
 */

function encode(value: unknown, path: string): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) throw new Error(`${path}: not a safe integer`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((v, i) => encode(v, `${path}[${i}]`)).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys
      .map((k) => {
        if (!/^[\x00-\x7f]*$/.test(k)) throw new Error(`${path}: non-ASCII key`);
        return `${JSON.stringify(k)}:${encode((value as Record<string, unknown>)[k], `${path}.${k}`)}`;
      })
      .join(",")}}`;
  }
  throw new Error(`${path}: unsupported type ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return encode(value, "$");
}

/** True when the browser offers SHA-256 (secure contexts: https or localhost). */
export function canHashLocally(): boolean {
  return typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.subtle?.digest === "function";
}

/** "sha256:<hex>" of the canonical JSON of `value`. */
export async function localDigest(value: unknown): Promise<string> {
  return sha256Text(canonicalJson(value));
}

/** "sha256:<hex>" of a string's UTF-8 bytes. */
export async function sha256Text(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}
