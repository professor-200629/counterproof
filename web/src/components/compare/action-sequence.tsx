import { Equal, EqualNot, ListOrdered } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Digest } from "@/components/ui/digest";
import { ActionList } from "@/components/evidence/action-list";
import type { CandidateAction, InitialState } from "@/lib/api";
import { cn } from "@/lib/cn";
import { sameActions } from "./ledger-facts";
import { plural } from "@/lib/format";

export interface ActionSequenceProps {
  /** Actions as replayed against the original version (from its evidence bundle / candidate). */
  before: CandidateAction[] | null;
  /** Actions as replayed against the other version (from the regression's evidence bundle). */
  after: CandidateAction[] | null;
  /** The original candidate's digest. */
  candidateDigest: string | null;
  /** The regression's candidate digest (re-bound to the replayed version's spec). */
  afterCandidateDigest?: string | null;
  /** The spec's synthetic initial state, to name products and merchants in plain words. */
  initialState?: Pick<InitialState, "products" | "merchants" | "currency"> | null;
  className?: string;
}

/**
 * The action sequence, shown once when both replays used the identical sequence (compared
 * field by field here). If they ever differ, both are shown and flagged.
 */
export function ActionSequence({ before, after, candidateDigest, afterCandidateDigest, initialState, className }: ActionSequenceProps) {
  const world = { products: initialState?.products, merchants: initialState?.merchants, currency: initialState?.currency || "SYN" };
  const compared = !!before && !!after;
  const identical = compared && sameActions(before, after);
  return (
    <Card as="section" className={cn("flex flex-col", className)} aria-label="Action sequence">
      <CardHeader
        eyebrow="Counterexample"
        title={
          <span className="inline-flex items-center gap-1.5">
            <ListOrdered aria-hidden="true" className="size-4 text-subtle" />
            Same action sequence
          </span>
        }
      />
      <CardBody className="flex-1 space-y-3">
        {!before ? (
          <p className="text-sm text-muted">The original sequence is not available yet.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {compared ? (
                identical ? (
                  <Badge tone="neutral" icon={<Equal />}>
                    Identical in both replays
                  </Badge>
                ) : (
                  <Badge tone="bad" icon={<EqualNot />}>
                    Sequences differ
                  </Badge>
                )
              ) : (
                <Badge tone="warn">Not replayed against another version</Badge>
              )}
              <span className="text-xs text-muted">
                {before.length} {plural(before.length, "action")}
              </span>
            </div>
            <ActionList
              {...world}
              actions={before}
              label={identical || !compared ? "Action sequence" : "Action sequence replayed against the original version"}
            />
            {compared && !identical && after ? (
              <>
                <p className="text-xs font-medium text-bad">Replayed against the other version:</p>
                <ActionList {...world} actions={after} label="Action sequence replayed against the other version" />
              </>
            ) : null}
            <div className="space-y-1 text-xs text-muted">
              <p className="flex flex-wrap items-center gap-1">
                Candidate <Digest value={candidateDigest} label="original candidate digest" />
              </p>
              {compared ? (
                <p>
                  {identical
                    ? "Compared field by field on this page. "
                    : "These sequences are not the same, so this is not a like-for-like comparison. "}
                  The regression&apos;s candidate digest
                  {afterCandidateDigest ? (
                    <>
                      {" "}
                      (<Digest value={afterCandidateDigest} label="regression candidate digest" copy={false} />)
                    </>
                  ) : null}{" "}
                  differs because the same actions are re-bound to the replayed version&apos;s spec.
                </p>
              ) : null}
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}
