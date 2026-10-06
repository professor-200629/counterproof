import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { CopyButton } from "./copy-button";
import { plural } from "@/lib/format";

export interface JsonViewProps {
  value: unknown;
  /** Accessible name / caption, e.g. "Candidate JSON". */
  label?: string;
  /** Nodes deeper than this start collapsed (root is depth 0). Default 1. */
  collapsedDepth?: number;
  /** Max height before the block scrolls (CSS length). Default 28rem. */
  maxHeight?: string;
  /** Show a "Copy JSON" button. Default true. */
  copy?: boolean;
  className?: string;
}

/**
 * Collapsible, monospace JSON tree using native <details> (keyboard accessible: Tab to a
 * node, Enter/Space toggles). Values are shown exactly as received.
 */
export function JsonView({ value, label, collapsedDepth = 1, maxHeight = "28rem", copy = true, className }: JsonViewProps) {
  const text = safeStringify(value);
  return (
    <figure className={cn("min-w-0 overflow-hidden rounded-lg border border-line bg-inset", className)}>
      {label || copy ? (
        <figcaption className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5 text-xs text-muted">
          <span className="truncate">{label ?? "JSON"}</span>
          {copy ? <CopyButton value={text} label={label ? `${label} as JSON` : "JSON"} showText /> : null}
        </figcaption>
      ) : null}
      <div className="overflow-auto px-3 py-2 font-mono text-xs leading-relaxed" style={{ maxHeight }}>
        <Node value={value} depth={0} collapsedDepth={collapsedDepth} />
      </div>
    </figure>
  );
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2) ?? String(v);
  } catch {
    return String(v);
  }
}

function Node({ value, depth, collapsedDepth, name }: { value: unknown; depth: number; collapsedDepth: number; name?: string }) {
  const keyLabel =
    name !== undefined ? (
      <>
        <span className="text-muted">{/^\d+$/.test(name) ? name : JSON.stringify(name)}</span>
        <span className="text-subtle">: </span>
      </>
    ) : null;

  if (value !== null && typeof value === "object") {
    const isArray = Array.isArray(value);
    const entries = isArray ? (value as unknown[]).map((v, i) => [String(i), v] as const) : Object.entries(value as object);
    const open = isArray ? "[" : "{";
    const close = isArray ? "]" : "}";
    if (entries.length === 0) {
      return (
        <div className="whitespace-pre">
          {keyLabel}
          <span className="text-subtle">
            {open}
            {close}
          </span>
        </div>
      );
    }
    const summary = isArray ? `${entries.length} ${plural(entries.length, "item")}` : `${entries.length} ${plural(entries.length, "key")}`;
    return (
      <details open={depth < collapsedDepth} className="group/json">
        <summary className="flex cursor-pointer items-center gap-0.5 rounded hover:bg-raised">
          <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-subtle transition-transform group-open/json:rotate-90" />
          <span className="whitespace-pre">
            {keyLabel}
            <span className="text-subtle">{open}</span>
            <span className="text-subtle group-open/json:hidden">
              {" "}
              {summary} {close}
            </span>
          </span>
        </summary>
        <div className="ml-1.5 border-l border-line pl-3">
          {entries.map(([k, v]) => (
            <Node key={k} name={k} value={v} depth={depth + 1} collapsedDepth={collapsedDepth} />
          ))}
        </div>
        <div className="pl-3.5 text-subtle">{close}</div>
      </details>
    );
  }

  return (
    <div className="break-all pl-3.5">
      {keyLabel}
      <Scalar value={value} />
    </div>
  );
}

function Scalar({ value }: { value: unknown }) {
  if (value === null) return <span className="text-subtle">null</span>;
  if (value === undefined) return <span className="text-subtle">undefined</span>;
  // Neutral colours only: green/amber/red are reserved for verdicts and transaction states.
  if (typeof value === "string") return <span className="text-fg">{JSON.stringify(value)}</span>;
  if (typeof value === "number" || typeof value === "bigint") return <span className="text-fg tabular">{String(value)}</span>;
  if (typeof value === "boolean") return <span className="font-semibold text-fg">{String(value)}</span>;
  return <span>{String(value)}</span>;
}
