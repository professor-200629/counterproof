/**
 * Server-render a page view with a primed react-query cache, for route state tests.
 * Nothing is fetched: queries either hold real backend fixtures, an error, or stay pending.
 */
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";

/** A real backend response, captured verbatim from the running API into src/test/fixtures. */
export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as T;
}

export interface Primed {
  data?: [QueryKey, unknown][];
  errors?: [QueryKey, unknown][];
}

export function render(element: ReactElement, primed: Primed = {}): { html: string; text: string } {
  const qc = new QueryClient({
    // retryOnMount: false keeps a primed error an error instead of an optimistic refetch.
    defaultOptions: { queries: { staleTime: Infinity, retry: false, retryOnMount: false } },
  });
  for (const [key, value] of primed.data ?? []) qc.setQueryData(key, value);
  for (const [key, error] of primed.errors ?? []) {
    qc.getQueryCache().build(qc, { queryKey: key }, {
      data: undefined,
      dataUpdateCount: 0,
      dataUpdatedAt: 0,
      error: error as Error,
      errorUpdateCount: 1,
      errorUpdatedAt: Date.now(),
      fetchFailureCount: 1,
      fetchFailureReason: error as Error,
      fetchMeta: null,
      isInvalidated: false,
      status: "error",
      fetchStatus: "idle",
    });
  }
  const html = renderToString(
    createElement(WagmiProvider, { config: wagmiConfig }, createElement(QueryClientProvider, { client: qc }, element)),
  );
  return { html, text: toText(html) };
}

/** Visible text of rendered HTML, whitespace collapsed and common entities decoded. */
export function toText(html: string): string {
  return html
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");
}

/** Internal hrefs in rendered HTML, for link checks. */
export function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
}
