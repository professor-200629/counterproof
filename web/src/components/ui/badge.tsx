import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { toneSurface, type Tone } from "./tone";

export type BadgeSize = "sm" | "md" | "lg";

const sizes: Record<BadgeSize, string> = {
  sm: "h-5 gap-1 px-1.5 text-[11px] [&_svg]:size-3",
  md: "h-6 gap-1.5 px-2 text-xs [&_svg]:size-3.5",
  lg: "min-h-8 gap-2 px-2.5 py-1 text-sm font-semibold [&_svg]:size-4",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  size?: BadgeSize;
  /** Decorative icon (hidden from screen readers). */
  icon?: ReactNode;
}

/** Small pill with a semantic tone. Text must carry the meaning; colour only reinforces it. */
export function Badge({ tone = "neutral", size = "md", icon, className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center border font-medium",
        size === "lg" ? "rounded-md leading-snug" : "rounded-full leading-none",
        toneSurface[tone],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {icon ? (
        <span aria-hidden="true" className="inline-flex shrink-0">
          {icon}
        </span>
      ) : null}
      <span className={size === "lg" ? "min-w-0" : "truncate"}>{children}</span>
    </span>
  );
}
