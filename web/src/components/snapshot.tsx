import { History, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TextLink } from "@/components/ui/text-link";
import { cn } from "@/lib/cn";
import { SNAPSHOT_MODE, SNAPSHOT_SOURCE_URL } from "@/lib/snapshot";

/**
 * Small "recorded" marker next to a value that could be mistaken for live (counts of active
 * runs, reachability, contract values). Renders nothing outside snapshot mode.
 */
export function RecordedMark({ className, what = "This value" }: { className?: string; what?: string }) {
  if (!SNAPSHOT_MODE) return null;
  return (
    <Badge
      tone="neutral"
      size="sm"
      icon={<History />}
      className={cn("align-middle", className)}
      title={`${what} was recorded when the snapshot was taken. It is not live and does not update.`}
    >
      recorded
    </Badge>
  );
}

/**
 * Inline explanation in place of an action control in snapshot mode: what the control does,
 * why it is not here, and where to run the evaluator. Never a disabled button that looks
 * clickable.
 */
export function ReadOnlyNote({ action, className }: { action: string; className?: string }) {
  return (
    <p
      role="note"
      className={cn("flex items-start gap-2 rounded-md border border-dashed border-line-strong bg-inset px-3 py-2 text-xs text-muted", className)}
    >
      <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-subtle" />
      <span className="min-w-0">
        <span className="font-medium text-fg">Read-only recorded snapshot:</span> {action} needs the CounterProof evaluator
        backend, which runs only on its owner&apos;s machine. Nothing here can start, sign or send anything.{" "}
        <SourceLink>Run it yourself (README)</SourceLink>
      </span>
    </p>
  );
}


/** Link to the source README when it is published; otherwise an honest plain-text note. */
export function SourceLink({ children, className }: { children: React.ReactNode; className?: string }) {
  if (!SNAPSHOT_SOURCE_URL) {
    return <span className={className}>{children}: source repository not published yet</span>;
  }
  return (
    <TextLink href={SNAPSHOT_SOURCE_URL} className={className}>
      {children}
    </TextLink>
  );
}
