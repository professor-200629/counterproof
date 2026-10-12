import { useChallengeRegressions } from "@/lib/queries";
import { SNAPSHOT_MODE } from "@/lib/snapshot";
import { replayRelation } from "@/lib/target-labels";

/**
 * The text of a link to the before / after page. In a recording it says whether a repaired
 * version (another version of the same adapter) was actually replayed, so a link never promises
 * a comparison that was not recorded; while that is unknown it says only "Before / after".
 * Live, `liveLabel` names the action the page offers.
 */
export function compareLinkLabel(repairRecorded: boolean | null, liveLabel: string, snapshot: boolean = SNAPSHOT_MODE): string {
  if (!snapshot) return liveLabel;
  if (repairRecorded === true) return "Before / after (repair recorded)";
  if (repairRecorded === false) return "Before / after (no repair recorded)";
  return "Before / after";
}

/**
 * compareLinkLabel for one challenge (optionally one counterexample of it), from the recorded
 * regressions. Reads them only in a recording; live, nothing is fetched for a link label.
 */
export function useCompareLinkLabel(
  challengeId: number | string,
  target: { adapter: string; version: string } | null | undefined,
  liveLabel: string,
  candidateId?: string | null,
): string {
  const regsQ = useChallengeRegressions(challengeId, { enabled: SNAPSHOT_MODE });
  const regs = regsQ.data;
  const recorded =
    regs && target
      ? regs.some(
          (r) =>
            String(r.source_challenge_id) === String(challengeId) &&
            (!candidateId || r.source_candidate_id === candidateId) &&
            replayRelation(r.target_key, target) === "repair",
        )
      : null;
  return compareLinkLabel(recorded, liveLabel);
}
