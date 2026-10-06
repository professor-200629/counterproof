import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { middleTruncate, truncateDigest } from "@/lib/format";
import { CopyButton } from "./copy-button";

export interface DigestProps {
  /** A digest ("sha256:..."), bytes32 / tx hash ("0x..."), or any id. */
  value: string | null | undefined;
  /** What this value is ("evidence digest"); used in the copy button's accessible name. */
  label?: string;
  /** Characters kept before/after the ellipsis (after the "sha256:" prefix). */
  head?: number;
  tail?: number;
  /** Show the whole value (wraps) instead of truncating. */
  full?: boolean;
  copy?: boolean;
  /** Optional link (e.g. explorer URL or evidence page). */
  href?: string | null;
  /** Text when the value is missing. */
  emptyText?: string;
  className?: string;
}

/** Monospace, middle-truncated digest with the full value in `title` and a copy button. */
export function Digest({
  value,
  label = "digest",
  head = 8,
  tail = 6,
  full = false,
  copy = true,
  href,
  emptyText = "not available",
  className,
}: DigestProps) {
  if (!value) return <span className={cn("text-sm text-subtle", className)}>{emptyText}</span>;
  const shown = full ? value : value.includes(":") ? truncateDigest(value, head, tail) : middleTruncate(value, head + 2, tail);
  const text = (
    <span className={cn("font-mono text-xs", href ? "text-accent-text" : "text-fg", full ? "break-all" : "whitespace-nowrap")} title={value}>
      {shown}
    </span>
  );
  return (
    <span className={cn("inline-flex min-w-0 max-w-full items-center gap-1 align-middle", className)}>
      {href && href.startsWith("/") ? (
        <Link href={href} className="inline-flex min-w-0 items-center gap-1 text-accent-text underline-offset-2 hover:underline">
          {text}
        </Link>
      ) : href ? (
        <a
          href={href}
          className="inline-flex min-w-0 items-center gap-1 text-accent-text underline-offset-2 hover:underline"
          {...(href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        >
          {text}
          {href.startsWith("http") ? (
            <>
              <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
              <span className="sr-only">(opens in a new tab)</span>
            </>
          ) : null}
        </a>
      ) : (
        text
      )}
      {copy ? <CopyButton value={value} label={label} /> : null}
    </span>
  );
}
