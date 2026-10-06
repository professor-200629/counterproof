import { StatusBadge } from "@/components/ui/status-badge";
import { TimeAgo } from "@/components/ui/time";
import type { Job } from "@/lib/api";
import { cn } from "@/lib/cn";

export interface JobFactsProps {
  /** The backend job behind a queued / replaying evaluation or regression; null before a worker sees it. */
  job: Job | null | undefined;
  /** When the work was requested (unix seconds), and what to call that moment. */
  requestedAt: number;
  requestedLabel?: string;
  className?: string;
}

/**
 * What the backend reports about a background job: when it was requested, its status,
 * the attempt, the worker and its last heartbeat. Only reported values; the worker sends
 * no partial progress, so none is shown or estimated.
 */
export function JobFacts({ job, requestedAt, requestedLabel = "Queued", className }: JobFactsProps) {
  return (
    <dl className={cn("flex flex-wrap gap-x-6 gap-y-1 text-xs", className)}>
      <div className="flex gap-1">
        <dt className="text-muted">{requestedLabel}</dt>
        <dd>
          <TimeAgo ts={requestedAt} />
        </dd>
      </div>
      {job ? (
        <>
          <div className="flex items-center gap-1">
            <dt className="text-muted">Job</dt>
            <dd className="flex items-center gap-1.5">
              <StatusBadge status={job.status} domain="job" size="sm" />
              <span className="font-mono text-muted">{job.id}</span>
            </dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-muted">Attempt</dt>
            <dd className="tabular">
              {job.attempts} of {job.max_attempts}
            </dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-muted">Worker</dt>
            <dd className="font-mono">{job.worker ?? "none yet"}</dd>
          </div>
          {job.started_at ? (
            <div className="flex gap-1">
              <dt className="text-muted">Started</dt>
              <dd>
                <TimeAgo ts={job.started_at} />
              </dd>
            </div>
          ) : null}
          <div className="flex gap-1">
            <dt className="text-muted">Last heartbeat</dt>
            <dd>
              <TimeAgo ts={job.heartbeat_at} emptyText="none yet" />
            </dd>
          </div>
        </>
      ) : (
        <div className="flex gap-1">
          <dt className="text-muted">Job</dt>
          <dd className="text-subtle">not reported by the backend</dd>
        </div>
      )}
    </dl>
  );
}
