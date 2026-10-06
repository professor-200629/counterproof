import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { shortAddress } from "@/lib/format";
import { CopyButton } from "./copy-button";

export interface AddressProps {
  value: string | null | undefined;
  /** Role of the address ("evaluator", "recipient"); used for the copy label and shown as a prefix when `showRole`. */
  label?: string;
  showRole?: boolean;
  full?: boolean;
  copy?: boolean;
  /** Explorer or internal link. */
  href?: string | null;
  /** Extra marker after the address, e.g. "you" or the dev-account warning. */
  note?: string;
  emptyText?: string;
  className?: string;
}

/** 0x-address, mono, shortened to 0x1234…abcd with the full value in `title` and a copy button. */
export function Address({
  value,
  label = "address",
  showRole = false,
  full = false,
  copy = true,
  href,
  note,
  emptyText = "not set",
  className,
}: AddressProps) {
  if (!value) return <span className={cn("text-sm text-subtle", className)}>{emptyText}</span>;
  const shown = full ? value : shortAddress(value);
  const text = (
    <span className={cn("font-mono text-xs", href ? "text-accent-text" : "text-fg", full ? "break-all" : "whitespace-nowrap")} title={value}>
      {shown}
    </span>
  );
  return (
    <span className={cn("inline-flex min-w-0 max-w-full flex-wrap items-center gap-1 align-middle", className)}>
      {showRole ? <span className="text-xs text-muted">{label}</span> : null}
      {href && href.startsWith("/") ? (
        <Link href={href} className="inline-flex items-center gap-1 text-accent-text underline-offset-2 hover:underline">
          {text}
        </Link>
      ) : href ? (
        <a
          href={href}
          className="inline-flex items-center gap-1 text-accent-text underline-offset-2 hover:underline"
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
      {note ? <span className="text-xs text-muted">({note})</span> : null}
    </span>
  );
}
