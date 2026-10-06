"use client";

import { useState } from "react";
import { ActivityList, ActivityRef } from "@/components/activity-list";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import type { ActivityEntry, ChallengeListItem } from "@/lib/api";
import { chainIdForNetwork } from "@/lib/chain";
import { plural } from "@/lib/format";

export interface ActivityFeedProps {
  /** overview.activity, newest first, as the backend returns it. */
  entries: ActivityEntry[];
  /** Challenge rows, used for link titles and the chain a transaction ref belongs to. */
  challenges?: ChallengeListItem[];
  /** Entries shown before "Show all". */
  initial?: number;
}

/**
 * The backend's activity log with time-ago and links: every entry links its challenge,
 * evaluation refs open the evidence page, regression refs the repair comparison, and
 * transaction refs link to MonadScan only when the challenge is on Monad testnet.
 */
export function ActivityFeed({ entries, challenges, initial = 10 }: ActivityFeedProps) {
  const [expanded, setExpanded] = useState(false);
  if (entries.length === 0) {
    return (
      <EmptyState
        compact
        title="No activity yet"
        description="The backend logs challenge creation, runs, submissions, evaluator verdicts and transactions here as they happen."
      />
    );
  }
  const byId = new Map((challenges ?? []).map((c) => [c.id, c] as const));
  return (
    <div className="space-y-2">
      <ActivityList
        entries={entries}
        limit={expanded ? undefined : initial}
        renderRef={(e) => {
          const challenge = e.challenge_id != null ? byId.get(e.challenge_id) : undefined;
          return (
            <ActivityRef
              entry={e}
              linkChallenge
              challengeTitle={challenge?.title}
              chainId={challenge ? (challenge.chain_id ?? chainIdForNetwork(challenge.network)) : null}
            />
          );
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-subtle">
          Latest {entries.length} {plural(entries.length, "entry", "entries")} of the backend&apos;s log, newest first. Messages are shown verbatim.
        </p>
        {entries.length > initial ? (
          <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded((x) => !x)}>
            {expanded ? `Show the latest ${initial} only` : `Show all ${entries.length}`}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
