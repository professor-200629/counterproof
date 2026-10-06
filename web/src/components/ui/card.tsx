import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { toneSurface, type Tone } from "./tone";

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** Render as another element (e.g. "section", "article", "li"). Default "div". */
  as?: "div" | "section" | "article" | "li" | "aside";
  /** Coloured left edge to flag a verdict / state. */
  tone?: Tone;
  padded?: boolean;
}

/** Bordered surface. Compose with CardHeader / CardBody / CardFooter, or use `padded`. */
export function Card({ as: As = "div", tone, padded = false, className, children, ...rest }: CardProps) {
  return (
    <As
      className={cn(
        "min-w-0 rounded-lg border border-line bg-surface",
        tone && tone !== "neutral" && "border-l-4",
        tone === "ok" && "border-l-ok",
        tone === "warn" && "border-l-warn",
        tone === "bad" && "border-l-bad",
        tone === "accent" && "border-l-accent",
        padded && "p-4 sm:p-5",
        className,
      )}
      {...rest}
    >
      {children}
    </As>
  );
}

export interface CardHeaderProps {
  title: ReactNode;
  /** Heading level for the title (default 3). */
  level?: 2 | 3 | 4;
  description?: ReactNode;
  /** Right-aligned controls (buttons, badges). */
  actions?: ReactNode;
  /** Small label above the title (e.g. "Rule R1"). */
  eyebrow?: ReactNode;
  id?: string;
  className?: string;
}

export function CardHeader({ title, level = 3, description, actions, eyebrow, id, className }: CardHeaderProps) {
  const H = `h${level}` as "h2" | "h3" | "h4";
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-3 sm:px-5", className)}>
      <div className="min-w-0 flex-1">
        {eyebrow ? <div className="mb-0.5 text-xs font-medium uppercase tracking-wide text-subtle">{eyebrow}</div> : null}
        <H id={id} className="text-sm font-semibold text-fg">
          {title}
        </H>
        {description ? <div className="mt-0.5 text-sm text-muted">{description}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function CardBody({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("px-4 py-4 sm:px-5", className)} {...rest}>
      {children}
    </div>
  );
}

export function CardFooter({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-wrap items-center gap-2 border-t border-line px-4 py-3 text-sm text-muted sm:px-5", className)}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface CalloutProps {
  tone?: Tone;
  title?: ReactNode;
  icon?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** "status" for live updates, "note" (default) for static notices. */
  role?: "status" | "note" | "alert";
}

/** Inline notice: limitations, trust statements, warnings. */
export function Callout({ tone = "neutral", title, icon, children, className, role = "note" }: CalloutProps) {
  return (
    <div role={role} className={cn("flex gap-3 rounded-md border px-3 py-2.5 text-sm", toneSurface[tone], className)}>
      {icon ? (
        <span aria-hidden="true" className="mt-0.5 shrink-0 [&>svg]:size-4">
          {icon}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        {title ? <div className="font-semibold">{title}</div> : null}
        {children ? <div className={cn(title && "mt-0.5", "text-fg/90")}>{children}</div> : null}
      </div>
    </div>
  );
}
