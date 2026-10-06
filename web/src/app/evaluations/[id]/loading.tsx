import { Loading } from "@/components/ui/states";

/** Instant placeholder while the evidence page loads. No progress is implied. */
export default function EvaluationLoading() {
  return <Loading label="evaluation evidence" rows={8} card />;
}
