import { ListChecks } from "lucide-react";
import { ReadOnlyNote } from "@/components/snapshot";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/section";
import { SourceLink } from "@/components/snapshot";
import { STEPS, STEP_INTRO } from "./steps";

/**
 * /challenges/new in the read-only snapshot: what the five wizard steps do, without a
 * wizard. The real one needs the evaluator backend from its first step (the canonical spec
 * preview and digest come from POST /api/specs/preview), so none of it is shown as usable.
 */
export function SnapshotCreateExplainer() {
  return (
    <>
      <PageHeader
        title="Create challenge"
        description="How a challenge is published. This hosted copy is a read-only recording, so the wizard is not available here."
        actions={
          <ButtonLink href="/challenges" icon={<ListChecks />}>
            Browse the recorded challenges
          </ButtonLink>
        }
      />
      <div className="space-y-6">
        <ReadOnlyNote action="Creating a challenge (previewing the canonical spec and its digest, storing it and, on chain, funding it)" />
        <Card>
          <CardHeader
            title="The five steps of the create wizard"
            level={2}
            description="With the evaluator running locally, the console walks through these steps and publishes the exact spec it shows you."
          />
          <CardBody>
            <ol className="space-y-4" aria-label="Create-challenge steps">
              {STEPS.map((step, i) => (
                <li key={step.id} className="flex gap-3">
                  <span
                    aria-hidden="true"
                    className="flex size-7 shrink-0 items-center justify-center rounded-full border border-line-strong text-xs font-semibold tabular text-muted"
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-fg">
                      <span className="sr-only">Step {i + 1}: </span>
                      {step.label} <span className="font-normal text-muted">- {step.description}</span>
                    </p>
                    <p className="mt-0.5 text-sm text-muted">{STEP_INTRO[step.id]}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="mt-5 text-sm text-muted">
              To create one yourself, run the CounterProof evaluator (API, worker, signer and a chain) as described in the{" "}
              <SourceLink>README</SourceLink>.
            </p>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
