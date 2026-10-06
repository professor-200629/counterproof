import { ExternalLink } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Classes of an inline accent link. Underlined by default: colour alone does not separate a
 * link from running text (WCAG 1.4.1); hover thickens the underline.
 */
export const textLinkClasses =
  "inline-flex items-center gap-1 rounded-sm text-accent-text underline decoration-1 underline-offset-2 hover:decoration-2";

export interface TextLinkProps {
  href: string;
  children: ReactNode;
  className?: string;
  /** Opens in a new tab with an external-link glyph (explorer links). Implied for http(s) hrefs. */
  external?: boolean;
  /** A file download from the API (plain <a download>, same tab, no external glyph). */
  download?: boolean;
  title?: string;
  "aria-label"?: string;
}

/**
 * Inline accent link. Internal hrefs use next/link; http(s) hrefs open in a new tab and say
 * so to screen readers; `download` links stay plain anchors.
 */
export function TextLink({ href, children, className, external, download, title, "aria-label": ariaLabel }: TextLinkProps) {
  const cls = cn(textLinkClasses, className);
  if (download) {
    return (
      <a href={href} download className={cls} title={title} aria-label={ariaLabel}>
        {children}
      </a>
    );
  }
  if (external || /^https?:\/\//.test(href)) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={cls} title={title} aria-label={ariaLabel}>
        {children}
        <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
        <span className="sr-only">(opens in a new tab)</span>
      </a>
    );
  }
  return (
    <Link href={href} className={cls} title={title} aria-label={ariaLabel}>
      {children}
    </Link>
  );
}

/** Small mono chip for identifiers (rule ids, action types, template ids, SKUs). */
export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("rounded border border-line bg-inset px-1.5 py-0.5 font-mono text-[11px] text-fg", className)}>
      {children}
    </span>
  );
}

/** A wrapping list of Mono chips, or a muted word when there are none. */
export function MonoList({
  items,
  label,
  empty = "none",
  className,
}: {
  items: ReactNode[];
  /** Accessible name of the list ("Allowed actions"). */
  label?: string;
  empty?: ReactNode;
  className?: string;
}) {
  if (items.length === 0) return <span className={cn("text-sm text-subtle", className)}>{empty}</span>;
  return (
    <ul aria-label={label} className={cn("flex flex-wrap gap-1", className)}>
      {items.map((it, i) => (
        <li key={i}>
          <Mono>{it}</Mono>
        </li>
      ))}
    </ul>
  );
}
