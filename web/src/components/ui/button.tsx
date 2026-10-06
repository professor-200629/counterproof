import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

// Labels may wrap: several actions carry a network or amount ("Relay settle() on Monad Testnet
// (10143)") that does not fit one line at 375px. min-h keeps one-line buttons at their usual size.
const base =
  "inline-flex max-w-full items-center justify-center gap-2 rounded-md border text-center font-medium select-none " +
  "transition-colors disabled:cursor-not-allowed disabled:opacity-55 aria-disabled:cursor-not-allowed aria-disabled:opacity-55";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg border-transparent hover:bg-accent-hover",
  secondary: "bg-raised text-fg border-line hover:border-line-strong hover:bg-surface",
  ghost: "bg-transparent text-muted border-transparent hover:text-fg hover:bg-raised",
  danger: "bg-transparent text-bad border-bad-line hover:bg-bad-soft",
};

const sizes: Record<ButtonSize, string> = {
  sm: "min-h-8 px-2.5 py-1 text-xs",
  md: "min-h-9 px-3.5 py-1.5 text-sm",
};

export function buttonClasses(variant: ButtonVariant = "secondary", size: ButtonSize = "md", className?: string): string {
  return cn(base, variants[variant], sizes[size], className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  ref?: Ref<HTMLButtonElement>;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon element rendered before the label (decorative; give the button a text label). */
  icon?: ReactNode;
  /**
   * While true the button is disabled, aria-busy, and shows `busyLabel` instead of its
   * children. No spinner: we never imply progress we cannot measure.
   */
  busy?: boolean;
  busyLabel?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  busy = false,
  busyLabel,
  disabled,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClasses(variant, size, className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {icon ? <span aria-hidden="true" className="inline-flex shrink-0 [&>svg]:size-4">{icon}</span> : null}
      {busy && busyLabel ? busyLabel : children}
    </button>
  );
}

export interface ButtonLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  /** Use a plain <a> (downloads, external links) instead of next/link. */
  external?: boolean;
}

/** A link styled as a button. Internal hrefs use next/link. */
export function ButtonLink({ href, variant = "secondary", size = "md", icon, external, className, children, ...rest }: ButtonLinkProps) {
  const content = (
    <>
      {icon ? <span aria-hidden="true" className="inline-flex shrink-0 [&>svg]:size-4">{icon}</span> : null}
      {children}
    </>
  );
  const cls = buttonClasses(variant, size, className);
  if (external) {
    return (
      <a href={href} className={cls} {...rest}>
        {content}
      </a>
    );
  }
  return (
    <Link href={href} className={cls} {...rest}>
      {content}
    </Link>
  );
}
