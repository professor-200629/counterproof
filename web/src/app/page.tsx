import type { Metadata } from "next";
import { OverviewView } from "@/components/overview/overview-view";

export const metadata: Metadata = {
  title: "Overview",
  description:
    "Challenges, evaluator results, recent activity and the trust model of this CounterProof backend.",
};

export default function OverviewPage() {
  return <OverviewView />;
}
