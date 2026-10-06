import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EvidenceViewer } from "@/components/evidence/evidence-viewer";

interface Props {
  params: Promise<{ id: string }>;
}

/** Evaluation ids are backend identifiers such as "eval_3b1db2b8553c44a7". */
const EVALUATION_ID = /^[A-Za-z0-9_.-]{1,128}$/;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return {
    title: `Evidence ${EVALUATION_ID.test(id) ? id : ""}`.trim(),
    description: "Independent replay evidence: the promise, what failed, the counterexample, who checked it and whether the reward moved.",
  };
}

/** Evidence viewer for one evaluation (independent replay by the declared trusted evaluator). */
export default async function EvaluationPage({ params }: Props) {
  const { id } = await params;
  if (!EVALUATION_ID.test(id)) notFound();
  return <EvidenceViewer id={id} />;
}
