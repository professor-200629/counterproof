import type { Metadata } from "next";
import { ChallengesListView } from "@/components/overview/challenges-list-view";

export const metadata: Metadata = {
  title: "Challenges",
  description: "Every published promise on this CounterProof backend with its status, network, evaluator results and deadlines.",
};

export default function ChallengesPage() {
  return <ChallengesListView />;
}
