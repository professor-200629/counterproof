import { CircleAlert, Inbox, SearchX, Unplug } from "lucide-react";
import type { ReactNode } from "react";
import { ApiError, isBackendUnreachable } from "@/lib/api";
import { cn } from "@/lib/cn";

// ---------------------------------------------------------------------------- empty
export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  /** A next step: usually a Button / ButtonLink. */
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
  /** Smaller variant for use inside cards and tables. */
  compact?: boolean;
}

/** Nothing to show yet - say why and what to do next. */
export function EmptyState({ title, description, action, icon, className, compact }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed border-line text-center",
        compact ? "gap-1.5 px-4 py-6" : "gap-2 px-6 py-12",
        className,
      )}
    >
      <span aria-hidden="true" className="text-subtle [&>svg]:size-6">
        {icon ?? <Inbox />}
      </span>
      <p className="text-sm font-medium text-fg">{title}</p>
      {description ? <p className="max-w-md text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------- error
export interface ErrorStateProps {
  /** Any thrown value; ApiError shows the backend's own `detail`, status and path. */
  error: unknown;
  title?: ReactNode;
  /** Called by the "Try again" button (e.g. query.refetch). */
  onRetry?: () => void;
  className?: string;
  compact?: boolean;
}

/** Shows what went wrong in the backend's words. Never hides the detail. */
export function ErrorState({ error, title, onRetry, className, compact }: ErrorStateProps) {
  const unreachable = isBackendUnreachable(error);
  const api = error instanceof ApiError ? error : null;
  const detail = api ? api.detail : error instanceof Error ? error.message : String(error ?? "Unknown error");
  const heading = title ?? (unreachable ? "Backend unreachable" : api?.status === 404 ? "Not found" : "Request failed");
  return (
    <div
      role="alert"
      className={cn(
        "rounded-lg border border-bad-line bg-bad-soft text-sm",
        compact ? "px-3 py-2.5" : "px-4 py-4",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="mt-0.5 text-bad [&>svg]:size-4">
          {unreachable ? <Unplug /> : <CircleAlert />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-bad">{heading}</p>
          <p className="mt-1 break-words text-fg">{detail}</p>
          {api && !unreachable ? (
            <p className="mt-1 font-mono text-xs text-muted">
              HTTP {api.status}
              {api.kind ? ` - ${api.kind}` : ""} - /api{api.path}
            </p>
          ) : null}
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="mt-3 inline-flex h-8 items-center rounded-md border border-line bg-surface px-3 text-xs font-medium text-fg hover:border-line-strong"
            >
              Try again
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------- loading
/** A grey placeholder block. Size it with className (h-4 w-32 ...). */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("rounded bg-raised motion-safe:animate-pulse", className)} />;
}

export interface LoadingProps {
  /** What is loading, announced to screen readers: "Loading challenge". */
  label: string;
  /** Number of placeholder rows. */
  rows?: number;
  className?: string;
  /** Card-shaped placeholder (header + rows). */
  card?: boolean;
}

/**
 * Skeleton placeholder while data loads. Deliberately no spinner or percentage: loading
 * says nothing about progress.
 */
export function Loading({ label, rows = 3, className, card = false }: LoadingProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn(card && "rounded-lg border border-line bg-surface p-4", "space-y-3", className)}
    >
      <span className="sr-only">Loading {label}</span>
      {card ? <Skeleton className="h-4 w-40" /> : null}
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn("h-3.5", i % 3 === 2 ? "w-1/2" : i % 3 === 1 ? "w-5/6" : "w-full")} />
      ))}
    </div>
  );
}

export interface QueryStateProps {
  /** A react-query result (or anything with these fields). */
  query: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  /** What is loading ("challenge"). */
  label: string;
  rows?: number;
  card?: boolean;
  /**
   * Shown instead of the red error when the backend answers 404: the thing does not exist,
   * which is an empty state with a way out, not a failure.
   */
  notFound?: Pick<EmptyStateProps, "title" | "description" | "action">;
  /** Heading of the error ("Could not load the challenge"); the backend's detail is always shown under it. */
  errorTitle?: ReactNode;
}

/** True when the backend answered 404 Not Found. */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/**
 * Renders Loading, a not-found EmptyState or ErrorState for a query, or null when data is ready:
 *   if (!q.data) return <QueryState query={q} label="challenge" />;
 */
export function QueryState({ query, label, rows, card, notFound, errorTitle }: QueryStateProps) {
  if (query.isPending) return <Loading label={label} rows={rows} card={card} />;
  if (query.isError) {
    if (notFound && isNotFound(query.error)) {
      return <EmptyState icon={<SearchX />} title={notFound.title} description={notFound.description} action={notFound.action} />;
    }
    // "Backend unreachable" says more than any page-specific heading.
    return <ErrorState error={query.error} title={isBackendUnreachable(query.error) ? undefined : errorTitle} onRetry={() => void query.refetch()} />;
  }
  return null;
}
