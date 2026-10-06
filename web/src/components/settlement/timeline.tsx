import type { ReactNode } from "react";
import { StepMarker, type StepState } from "@/components/ui/stepper";
import { cn } from "@/lib/cn";

/** Same states as the Stepper, so a step means the same thing in every flow. */
export type TimelineState = StepState;

const STATE_TEXT: Record<TimelineState, string> = {
  complete: "Done",
  current: "Next step",
  upcoming: "Not reached",
  error: "Failed",
  warning: "Needs attention",
  skipped: "Not applicable",
};

const STATE_PILL: Record<TimelineState, string> = {
  complete: "text-ok bg-ok-soft border-ok-line",
  current: "text-fg bg-raised border-line-strong",
  upcoming: "text-muted bg-surface border-line",
  error: "text-bad bg-bad-soft border-bad-line",
  warning: "text-warn bg-warn-soft border-warn-line",
  skipped: "text-muted bg-surface border-line",
};

/** Ordered vertical timeline. State is always spelled out in text, never colour alone. */
export function Timeline({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <ol aria-label={label} className={cn("min-w-0", className)}>
      {children}
    </ol>
  );
}

export interface TimelineStepProps {
  index: number;
  title: ReactNode;
  state: TimelineState;
  /** Overrides the default state words ("Done", "Next step", ...). */
  stateLabel?: string;
  /** One line under the title: the step's answer in brief. */
  summary?: ReactNode;
  last?: boolean;
  id?: string;
  children?: ReactNode;
}

export function TimelineStep({ index, title, state, stateLabel, summary, last, id, children }: TimelineStepProps) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <li
      id={id}
      aria-labelledby={headingId}
      aria-current={state === "current" ? "step" : undefined}
      className="relative flex min-w-0 scroll-mt-20 gap-3 sm:gap-4"
    >
      <div className="flex flex-col items-center" aria-hidden="true">
        <StepMarker state={state} number={index} size="md" />
        {!last ? <span className="mt-1 w-px flex-1 bg-line" /> : null}
      </div>
      <div className={cn("min-w-0 flex-1", last ? "pb-0" : "pb-7")}>
        <div className="flex min-h-7 flex-wrap items-center gap-x-2.5 gap-y-1">
          <h3 id={headingId} className={cn("text-sm font-semibold", state === "upcoming" || state === "skipped" ? "text-muted" : "text-fg")}>
            <span className="sr-only">Step {index}: </span>
            {title}
          </h3>
          <span
            className={cn(
              "inline-flex h-5 items-center rounded-full border px-1.5 text-[11px] font-medium leading-none",
              STATE_PILL[state],
            )}
          >
            {stateLabel ?? STATE_TEXT[state]}
          </span>
        </div>
        {summary ? <p className="mt-1 text-sm text-muted">{summary}</p> : null}
        {children ? <div className="mt-3 min-w-0 rounded-lg border border-line bg-surface p-4">{children}</div> : null}
      </div>
    </li>
  );
}
