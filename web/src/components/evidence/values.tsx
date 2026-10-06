import type { JsonValue } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";

/**
 * Keys whose numbers are synthetic-marketplace money (the checker and the market use
 * whole SYN units for these). Everything else is shown as a plain number.
 */
const MONEY_KEYS = new Set(["amount", "budget", "total_settled", "excess", "price", "balance"]);

export function isMoneyKey(key: string): boolean {
  return MONEY_KEYS.has(key);
}

/** One JSON value as compact text, exactly as received (numbers get thousands separators). */
export function valueText(key: string, value: JsonValue | undefined, currency = "SYN"): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "number") return isMoneyKey(key) ? `${formatNumber(value)} ${currency}` : formatNumber(value);
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** A value cell: null renders muted, strings/ids in mono. */
export function ValueCell({ name, value, currency }: { name: string; value: JsonValue | undefined; currency?: string }) {
  if (value === undefined) return <span className="text-subtle">-</span>;
  if (value === null) return <span className="font-mono text-xs text-subtle">null</span>;
  if (typeof value === "number") return <span className="tabular">{valueText(name, value, currency)}</span>;
  if (typeof value === "boolean") return <span className="font-mono text-xs">{String(value)}</span>;
  if (typeof value === "string") return <span className="break-all font-mono text-xs">{value}</span>;
  return <CompactJson value={value} />;
}

/** Inline `key: value` pairs for ledger event data and tool arguments. */
export function DataPairs({ data, currency, className }: { data: Record<string, JsonValue> | null | undefined; currency?: string; className?: string }) {
  const entries = data ? Object.entries(data) : [];
  if (entries.length === 0) return <span className="text-xs text-subtle">no data</span>;
  return (
    <dl className={cn("flex flex-wrap gap-x-3 gap-y-0.5 text-xs", className)}>
      {entries.map(([k, v]) => (
        <div key={k} className="flex min-w-0 max-w-full gap-1">
          <dt className="shrink-0 text-muted">{k}:</dt>
          <dd className="min-w-0 break-words font-mono text-fg">
            {v !== null && typeof v === "object" ? <CompactJson value={v} /> : valueText(k, v, currency)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Compact one-line JSON. Long values collapse into a native <details> so the full value
 * is one keypress away (Enter/Space on the summary).
 */
export function CompactJson({ value, max = 140, className }: { value: unknown; max?: number; className?: string }) {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  if (text.length <= max) return <code className={cn("break-all font-mono text-xs text-fg", className)}>{text}</code>;
  let pretty = text;
  try {
    pretty = JSON.stringify(value, null, 2);
  } catch {
    // keep the compact text
  }
  return (
    <details className={cn("min-w-0", className)}>
      <summary className="cursor-pointer break-all font-mono text-xs text-fg">
        {text.slice(0, max)}
        <span className="text-subtle">… (show all)</span>
      </summary>
      <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded border border-line bg-inset p-2 font-mono text-xs text-fg">
        {pretty}
      </pre>
    </details>
  );
}
