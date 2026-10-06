import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { TextLink } from "./text-link";

export interface Crumb {
  label: ReactNode;
  /** Omit for the current page (always the last crumb). */
  href?: string;
  /** Full text when the label is truncated (long challenge titles). */
  title?: string;
  /** Identifier-like label (#12, eval_...): mono font. */
  mono?: boolean;
}

/**
 * Breadcrumb trail for PageHeader's `breadcrumb` slot: "Challenges / <title> / Settlement".
 * Every crumb but the last is a link; the last is marked as the current page.
 */
export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className="flex min-w-0 flex-wrap items-center gap-1.5">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          const label = (
            <span className={cn("block min-w-0 truncate", c.mono && "font-mono text-xs")} title={c.title}>
              {c.label}
            </span>
          );
          return (
            <li key={i} className="flex min-w-0 max-w-full items-center gap-1.5">
              {i > 0 ? (
                <span aria-hidden="true" className="text-subtle">
                  /
                </span>
              ) : null}
              {last || !c.href ? (
                <span aria-current={last ? "page" : undefined} className="min-w-0 max-w-[16rem] text-fg sm:max-w-[28rem]">
                  {label}
                </span>
              ) : (
                <TextLink href={c.href} className="min-w-0 max-w-[16rem] sm:max-w-[28rem]">
                  {label}
                </TextLink>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * The standard trail for pages under one challenge: Challenges / <title or #id> [/ page].
 * Pass `page` for sub-pages (settlement, compare, evidence); without it the challenge is
 * the current page.
 */
export function challengeCrumbs(challengeId: number | string | null, title: string | null | undefined, page?: ReactNode): Crumb[] {
  const items: Crumb[] = [{ label: "Challenges", href: "/challenges" }];
  if (challengeId !== null && challengeId !== "") {
    items.push({
      label: title || `Challenge #${challengeId}`,
      title: title ? `${title} (#${challengeId})` : undefined,
      href: page === undefined ? undefined : `/challenges/${challengeId}`,
    });
  }
  if (page !== undefined) items.push({ label: page });
  return items;
}
