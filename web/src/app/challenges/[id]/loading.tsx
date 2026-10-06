import { Loading } from "@/components/ui/states";

/** Instant placeholder while a challenge page (detail, settlement, before / after) loads. No progress is implied. */
export default function ChallengeLoading() {
  return <Loading label="challenge" rows={8} card />;
}
