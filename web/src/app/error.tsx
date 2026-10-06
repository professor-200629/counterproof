"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/ui/states";

/** Route-level error boundary (Next 16: `retry` re-fetches and re-renders the segment). */
export default function RouteError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight text-fg">This page could not be shown</h1>
      <ErrorState error={error} title="Unexpected error while rendering" onRetry={retry} />
      {error.digest ? <p className="font-mono text-xs text-muted">Error digest: {error.digest}</p> : null}
    </div>
  );
}
