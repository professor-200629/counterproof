import type { RunBudget, RunRecord, RunStatus } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatDuration, formatNumber } from "@/lib/format";

export interface RunProgressProps {
  status: RunStatus | string;
  /** run.record - null until the worker reports. */
  record: RunRecord | null | undefined;
  /** run.budget (full Run) - falls back to record.budget. */
  budget?: RunBudget | null;
  className?: string;
}

/**
 * Search progress from real numbers only: sequences_tried / budget.max_sequences,
 * tool calls and elapsed time as reported by the worker. No estimates, no animation.
 */
export function RunProgress({ status, record, budget, className }: RunProgressProps) {
  const b = budget ?? record?.budget ?? null;
  if (!record) {
    return (
      <p className={cn("text-sm text-muted", className)}>
        {status === "queued"
          ? "Queued - the worker has not started; no progress reported yet."
          : status === "running"
            ? "Started - no progress reported yet."
            : "No search record."}
        {b ? ` Budget: ${formatNumber(b.max_sequences)} sequences / ${formatNumber(b.max_wall_seconds)} s.` : ""}
      </p>
    );
  }
  const max = b?.max_sequences ?? null;
  const tried = record.sequences_tried;
  const pct = max && max > 0 ? Math.min(100, (tried / max) * 100) : null;
  const finished = record.finished_at !== null || !!record.termination;
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
        <span className="text-fg">
          <span className="font-semibold tabular">{formatNumber(tried)}</span>
          {max ? <span className="text-muted tabular"> / {formatNumber(max)} sequences</span> : <span className="text-muted"> sequences</span>}
        </span>
        <span className="text-xs text-muted tabular">
          {formatNumber(record.tool_calls)} tool calls
          {record.model_calls ? ` - ${formatNumber(record.model_calls)} model calls` : ""} - {formatDuration(record.duration_ms)}
          {finished ? "" : " so far"}
        </span>
      </div>
      {pct !== null ? (
        <div
          role="progressbar"
          aria-label="Sequences tried of the search budget"
          aria-valuemin={0}
          aria-valuemax={max ?? undefined}
          aria-valuenow={tried}
          aria-valuetext={`${tried} of ${max} sequences`}
          className="h-1.5 w-full overflow-hidden rounded-full bg-raised"
        >
          <div className="h-full rounded-full bg-muted" style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      {finished && record.termination ? (
        <p className="text-xs text-muted">
          Stopped: <span className="text-fg">{record.termination}</span>
          {max && tried < max ? " (before the sequence budget was used up)" : ""}
        </p>
      ) : null}
    </div>
  );
}
