import type { Metadata } from "next";
import { SNAPSHOT_MODE } from "@/lib/snapshot";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ChallengeDetail } from "@/components/challenge/challenge-detail";
import { Loading } from "@/components/ui/states";

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return {
    title: `Challenge #${id}`,
    description: SNAPSHOT_MODE
      ? "Read-only recorded snapshot: what was promised, the recorded search runs, findings and evidence for one CounterProof challenge."
      : "What was promised, live testing, findings and evidence for one CounterProof challenge.",
  };
}

/** Challenge detail. The client view reads `?tab=` with useSearchParams, hence the Suspense boundary. */
export default async function ChallengePage({ params }: Props) {
  const { id } = await params;
  // Challenge ids are whole numbers; anything else is a wrong link, not a backend error.
  if (!/^\d+$/.test(id)) notFound();
  return (
    <Suspense fallback={<Loading label="challenge" rows={8} card />}>
      <ChallengeDetail id={id} />
    </Suspense>
  );
}
