import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SettlementView } from "@/components/settlement/settlement-view";

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  return {
    title: `Settlement - challenge #${id}`,
    description: "Funding, commitment, independent replay, attestation, settlement and withdrawal for one challenge.",
  };
}

export default async function SettlementPage({ params }: { params: Params }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  return <SettlementView challengeId={id} />;
}
