import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface SectionProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Anchor id for the section (deep links). */
  id?: string;
  /** Heading level (default 2). */
  level?: 2 | 3;
  className?: string;
  children?: ReactNode;
}

/** A labelled page region: <section aria-labelledby> with a heading row. */
export function Section({ title, description, actions, id, level = 2, className, children }: SectionProps) {
  const autoId = useId();
  const headingId = `${id ?? autoId}-heading`;
  const H = `h${level}` as "h2" | "h3";
  return (
    <section id={id} aria-labelledby={headingId} className={cn("min-w-0 scroll-mt-20", className)}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <H id={headingId} className={cn("font-semibold text-fg", level === 2 ? "text-base" : "text-sm")}>
            {title}
          </H>
          {description ? <p className="mt-0.5 max-w-3xl text-sm text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Badges / meta under the title. */
  meta?: ReactNode;
  actions?: ReactNode;
  /** Breadcrumb or back link above the title. */
  breadcrumb?: ReactNode;
}

/** The single <h1> of a page. */
export function PageHeader({ title, description, meta, actions, breadcrumb }: PageHeaderProps) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        {breadcrumb ? <div className="mb-2 text-sm text-muted">{breadcrumb}</div> : null}
        <h1 className="text-xl font-semibold tracking-tight text-fg sm:text-2xl">{title}</h1>
        {description ? <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p> : null}
        {meta ? <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
