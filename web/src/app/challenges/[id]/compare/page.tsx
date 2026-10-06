import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CompareView } from "@/components/compare/compare-view";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  return {
    title: `Before / after - challenge #${id}`,
    description: "A verified counterexample replayed against a repaired version, compared side by side and exported as a regression test.",
  };
}

function one(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s && /^[A-Za-z0-9_.@-]{1,128}$/.test(s) ? s : undefined;
}

export default async function ComparePage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  const sp = await searchParams;
  return (
    <CompareView
      challengeId={id}
      initial={{ candidate: one(sp.candidate), target: one(sp.target), regression: one(sp.regression) }}
    />
  );
}
