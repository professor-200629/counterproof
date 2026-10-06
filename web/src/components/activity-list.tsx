import type { ReactNode } from "react";
import { TxHash } from "@/components/tx-hash";
import { Digest } from "@/components/ui/digest";
import { StatusIconGlyph } from "@/components/ui/status-badge";
import { TextLink } from "@/components/ui/text-link";
import { TimeAgo } from "@/components/ui/time";
import { toneText } from "@/components/ui/tone";
import type { ActivityEntry } from "@/lib/api";
import { isDigest, isTxHash } from "@/lib/chain";
import { cn } from "@/lib/cn";
import { statusMeta, type Tone } from "@/lib/status";

const NEUTRAL_SUFFIXES = new Set(["queued", "started", "created", "running", "done", "signed", "pending"]);

/** Tone for an activity kind such as "evaluation.verified_violation" or "settle.confirmed". */
export function activityTone(kind: string): Tone {
  const suffix = kind.split(".").pop() ?? kind;
  if (NEUTRAL_SUFFIXES.has(suffix)) return "neutral";
  if (suffix === "funded") return "ok";
  return statusMeta(suffix).tone;
}

export interface ActivityListProps {
  entries: ActivityEntry[];
  /** Show at most this many entries (newest first, as the backend returns them). */
  limit?: number;
  /** Render each entry's ref (run id, evaluation id, tx hash) via this function, e.g. as a link. */
  renderRef?: (entry: ActivityEntry) => ReactNode;
  className?: string;
}

/** The backend's activity log, verbatim. Messages are the backend's own words; nothing is invented here. */
export function ActivityList({ entries, limit, renderRef, className }: ActivityListProps) {
  const shown = typeof limit === "number" ? entries.slice(0, limit) : entries;
  return (
    <ol className={cn("divide-y divide-line rounded-lg border border-line bg-surface", className)}>
      {shown.map((e) => {
        const tone = activityTone(e.kind);
        const suffix = e.kind.split(".").pop() ?? e.kind;
        const meta = statusMeta(suffix);
        return (
          <li key={e.id} className="flex gap-3 px-4 py-2.5 text-sm">
            <span className={cn("mt-0.5 shrink-0 [&>svg]:size-4", toneText[tone])}>
              <StatusIconGlyph icon={NEUTRAL_SUFFIXES.has(suffix) ? "dot" : meta.icon} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="break-words text-fg">{e.message}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
                <span className="font-mono">{e.kind}</span>
                <TimeAgo ts={e.created_at} />
                {renderRef ? renderRef(e) : null}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------- refs
const SETTLEMENT_KINDS = /^(challenge\.funded|(fund|commit|settle|refund|withdraw|attestation)\.)/;

export interface ActivityRefProps {
  entry: ActivityEntry;
  /** Chain of the entry's challenge, for transaction refs (null = off-chain or unknown). */
  chainId?: number | null;
  /** Feeds that span challenges also link the entry's challenge (with its title as tooltip). */
  linkChallenge?: boolean;
  challengeTitle?: string;
  /** Link payout-related entries to the settlement page (off on that page itself). */
  linkSettlement?: boolean;
}

/**
 * Where an activity entry points, as links: evaluation ids open the evidence page, run and
 * candidate ids the challenge's tabs, regression ids the before / after comparison, spec
 * digests stay digests, and transaction hashes link to MonadScan only on Monad testnet
 * (local anvil hashes say "local anvil (31337)"). Payout-related entries also link the
 * settlement page.
 */
export function ActivityRef({ entry, chainId = null, linkChallenge = false, challengeTitle, linkSettlement = true }: ActivityRefProps) {
  const cid = entry.challenge_id;
  const ref = entry.ref;
  let refNode: ReactNode = null;
  if (ref) {
    if (ref.startsWith("eval_")) {
      refNode = (
        <TextLink href={`/evaluations/${encodeURIComponent(ref)}`}>
          Evaluation <span className="font-mono">{ref}</span>
        </TextLink>
      );
    } else if (ref.startsWith("reg_") && cid != null) {
      refNode = (
        <TextLink href={`/challenges/${cid}/compare?regression=${encodeURIComponent(ref)}`}>
          Regression <span className="font-mono">{ref}</span>
        </TextLink>
      );
    } else if (ref.startsWith("run_") && cid != null) {
      refNode = (
        <TextLink href={`/challenges/${cid}?tab=testing`}>
          Run <span className="font-mono">{ref}</span>
        </TextLink>
      );
    } else if (ref.startsWith("cand_") && cid != null) {
      refNode = (
        <TextLink href={`/challenges/${cid}?tab=findings`}>
          Candidate <span className="font-mono">{ref}</span>
        </TextLink>
      );
    } else if (isDigest(ref)) {
      refNode = (
        <span className="inline-flex items-center gap-1">
          spec <Digest value={ref} label="spec digest" head={8} tail={4} />
        </span>
      );
    } else if (isTxHash(ref)) {
      refNode = <TxHash hash={ref} chainId={chainId} label="transaction hash" head={6} tail={4} />;
    } else {
      refNode = (
        <span className="font-mono" title={ref}>
          {ref}
        </span>
      );
    }
  }
  return (
    <>
      {linkChallenge && cid != null ? (
        <TextLink href={`/challenges/${cid}`} title={challengeTitle}>
          Challenge #{cid}
        </TextLink>
      ) : null}
      {refNode}
      {linkSettlement && cid != null && SETTLEMENT_KINDS.test(entry.kind) ? <TextLink href={`/challenges/${cid}/settlement`}>Settlement</TextLink> : null}
    </>
  );
}
