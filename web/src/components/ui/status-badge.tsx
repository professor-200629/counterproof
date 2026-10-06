import {
  Activity,
  Ban,
  Bug,
  Check,
  CircleDot,
  CircleHelp,
  Clock,
  FileText,
  Lock,
  PenLine,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  Timer,
  TriangleAlert,
  Undo2,
  X,
  type LucideIcon,
} from "lucide-react";
import { statusMeta, type StatusDomain, type StatusIcon } from "@/lib/status";
import { Badge, type BadgeSize } from "./badge";

const ICONS: Record<StatusIcon, LucideIcon> = {
  clock: Clock,
  activity: Activity,
  search: Search,
  check: Check,
  x: X,
  alert: TriangleAlert,
  "shield-alert": ShieldAlert,
  "shield-check": ShieldCheck,
  help: CircleHelp,
  ban: Ban,
  lock: Lock,
  undo: Undo2,
  file: FileText,
  pen: PenLine,
  send: Send,
  timer: Timer,
  bug: Bug,
  dot: CircleDot,
};

export function StatusIconGlyph({ icon, className }: { icon: StatusIcon; className?: string }) {
  const Icon = ICONS[icon] ?? CircleDot;
  return <Icon aria-hidden="true" className={className} />;
}

export interface StatusBadgeProps {
  /** Any status / outcome string from the backend or the tx state machine. */
  status: string | null | undefined;
  /** Disambiguates shared words ("failed" for a run vs a transaction). */
  domain?: StatusDomain;
  size?: BadgeSize;
  /** Override the label (keeps the tone and icon). */
  label?: string;
  showIcon?: boolean;
  className?: string;
}

/**
 * Status pill: label + semantic colour + icon, from lib/status.ts. The description is
 * exposed as a tooltip and to screen readers.
 */
export function StatusBadge({ status, domain, size = "md", label, showIcon = true, className }: StatusBadgeProps) {
  const meta = statusMeta(status, domain);
  return (
    <Badge
      tone={meta.tone}
      size={size}
      className={className}
      icon={showIcon ? <StatusIconGlyph icon={meta.icon} /> : undefined}
      title={meta.description}
      data-status={status ?? undefined}
    >
      {label ?? meta.label}
      <span className="sr-only">. {meta.description}</span>
    </Badge>
  );
}
