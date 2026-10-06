import { Check, CircleDashed, TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type StepState = "complete" | "current" | "upcoming" | "error" | "warning" | "skipped";

export interface StepItem {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  state: StepState;
  /** Optional link target for the step (e.g. an anchor on the page). */
  href?: string;
}

export interface StepperProps {
  steps: StepItem[];
  /** Accessible name, e.g. "Challenge lifecycle". */
  label: string;
  orientation?: "horizontal" | "vertical";
  className?: string;
}

const STATE_TEXT: Record<StepState, string> = {
  complete: "completed",
  current: "current step",
  upcoming: "not started",
  error: "failed",
  warning: "needs attention",
  skipped: "not applicable",
};

const MARKER_TONE: Record<StepState, string> = {
  complete: "border-ok-line bg-ok-soft text-ok",
  current: "border-fg bg-raised text-fg",
  upcoming: "border-line bg-surface text-subtle",
  error: "border-bad-line bg-bad-soft text-bad",
  warning: "border-warn-line bg-warn-soft text-warn",
  skipped: "border-line bg-surface text-subtle",
};

/**
 * The round step marker: a glyph for finished / failed / warning / skipped states, the step
 * number otherwise. Decorative; the state is always spelled out in text next to it.
 */
export function StepMarker({ state, number, size = "sm" }: { state: StepState; number: number; size?: "sm" | "md" }) {
  const glyph = size === "md" ? "size-4" : "size-3.5";
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full border font-semibold tabular",
        size === "md" ? "size-7 text-xs" : "size-6 text-[11px]",
        MARKER_TONE[state],
      )}
    >
      {state === "complete" ? (
        <Check className={glyph} />
      ) : state === "error" ? (
        <X className={glyph} />
      ) : state === "warning" ? (
        <TriangleAlert className="size-3.5" />
      ) : state === "skipped" ? (
        <CircleDashed className="size-3.5" />
      ) : (
        number
      )}
    </span>
  );
}

/**
 * Ordered steps (e.g. Promise -> Search -> Replay -> Attest -> Settle -> Regression).
 * State is announced in text, not by colour alone. Horizontal stacks vertically on phones.
 */
export function Stepper({ steps, label, orientation = "horizontal", className }: StepperProps) {
  const horizontal = orientation === "horizontal";
  return (
    <div className={cn("min-w-0", className)}>
      <ol aria-label={label} className={cn("flex gap-3", horizontal ? "flex-col md:flex-row md:items-start md:gap-0" : "flex-col")}>
        {steps.map((s, i) => {
          const last = i === steps.length - 1;
          const inner = (
            <>
              <StepMarker state={s.state} number={i + 1} />
              <span className="min-w-0">
                <span className={cn("block text-sm font-medium", s.state === "upcoming" || s.state === "skipped" ? "text-muted" : "text-fg")}>
                  {s.label}
                  <span className="sr-only"> ({STATE_TEXT[s.state]})</span>
                </span>
                {s.description ? <span className="mt-0.5 block text-xs text-muted">{s.description}</span> : null}
              </span>
            </>
          );
          return (
            <li
              key={s.id}
              aria-current={s.state === "current" ? "step" : undefined}
              className={cn("relative flex min-w-0", horizontal && "md:flex-1 md:pr-3")}
            >
              {s.href ? (
                <a href={s.href} className="flex min-w-0 items-start gap-2.5 rounded-md hover:bg-raised/60">
                  {inner}
                </a>
              ) : (
                <div className="flex min-w-0 items-start gap-2.5">{inner}</div>
              )}
              {!last && horizontal ? (
                <span aria-hidden="true" className="ml-2 mt-3 hidden h-px flex-1 bg-line md:block" />
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
