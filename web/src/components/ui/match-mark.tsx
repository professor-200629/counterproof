import { CircleCheck, CircleX } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface MatchMarkProps {
  /** true = the two values match, false = they differ, null = they could not be compared. */
  ok: boolean | null;
  /** What the value was compared with: renders "matches <subject>" / "differs from <subject>". */
  subject?: ReactNode;
  /** Full wording when it matches (overrides the subject sentence). */
  okText?: ReactNode;
  /** Full wording when it differs (overrides the subject sentence). */
  badText?: ReactNode;
  /** Wording when nothing could be compared. Default: "not compared with <subject>" / "not comparable". */
  unknownText?: ReactNode;
  /** Muted note after the result. */
  children?: ReactNode;
  className?: string;
}

/**
 * An observed comparison made on this page (two digests, two addresses): green when the
 * values match, red when they differ, muted when one side is missing. The words carry the
 * meaning; the colour and glyph only reinforce it.
 */
export function MatchMark({ ok, subject, okText, badText, unknownText, children, className }: MatchMarkProps) {
  if (ok === null) {
    return (
      <span className={cn("text-xs text-subtle", className)}>
        {unknownText ?? (subject ? <>not compared with {subject}</> : "not comparable")}
      </span>
    );
  }
  const text = ok ? (okText ?? (subject ? <>matches {subject}</> : "matches")) : (badText ?? (subject ? <>differs from {subject}</> : "differs"));
  const Icon = ok ? CircleCheck : CircleX;
  return (
    <span className={cn("inline-flex items-start gap-1 text-xs font-medium", ok ? "text-ok" : "text-bad", className)}>
      <Icon aria-hidden="true" className="mt-px size-3.5 shrink-0" />
      <span>
        {text}
        {children ? <span className="font-normal text-muted"> {children}</span> : null}
      </span>
    </span>
  );
}
