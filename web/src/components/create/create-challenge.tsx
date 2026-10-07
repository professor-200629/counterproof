"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, FilePlus2, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useConnection } from "wagmi";
import {
  Button,
  ButtonLink,
  Callout,
  Digest,
  ErrorState,
  Loading,
  PageHeader,
  ProvenanceBadge,
  ReasonList,
  Stepper,
  type StepItem,
} from "@/components/ui";
import { useNow } from "@/components/ui/time";
import { api, type AppConfig, type SpecRequest, type Target } from "@/lib/api";
import { formatWei } from "@/lib/chain";
import { formatUnix } from "@/lib/format";
import { useConfig, useCreateChallenge, useCreateSpec, useRuleTemplates, useTargets } from "@/lib/queries";
import {
  DEFAULT_SUBMISSION_LEAD_S,
  MAX_RULES,
  buildPreviewRequest,
  ceilToMinute,
  hasErrors,
  initialDraft,
  networkPlan,
  nowSeconds,
  paramErrors,
  publisherPlan,
  rewardWei,
  ruleDraft,
  ruleIdFor,
  selectedTemplates,
  termsErrors,
  type Draft,
  type RuleDraft,
} from "./draft";
import { FundingPanel, type CreatedChallenge } from "./funding-panel";
import { StepReview, useLocalDigestCheck } from "./step-review";
import { StepRules } from "./step-rules";
import { StepScope } from "./step-scope";
import { StepTarget } from "./step-target";
import { StepTerms } from "./step-terms";
import { STEPS, STEP_INTRO } from "./steps";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** The create-challenge wizard (/challenges/new). */
export function CreateChallenge() {
  const config = useConfig();
  const targets = useTargets();
  const templates = useRuleTemplates();

  const header = (
    <PageHeader
      title="Create challenge"
      description="Publish measurable promises about an AI purchasing agent. Challengers search for action sequences that break them; a declared trusted evaluator replays each candidate in a fresh synthetic marketplace and a deterministic checker decides."
    />
  );

  if (config.isPending || targets.isPending || templates.isPending) {
    return (
      <>
        {header}
        <Loading label="targets, rule templates and backend configuration" rows={6} card />
      </>
    );
  }
  const failed = [config, targets, templates].find((q) => q.isError);
  if (failed || !config.data || !targets.data || !templates.data) {
    return (
      <>
        {header}
        <ErrorState
          error={failed?.error ?? new Error("Missing data from the backend")}
          title="Cannot load what a challenge is built from"
          onRetry={() => {
            void config.refetch();
            void targets.refetch();
            void templates.refetch();
          }}
        />
      </>
    );
  }

  return (
    <>
      {header}
      <Wizard config={config.data} refetchConfig={() => void config.refetch()} targets={targets.data} templates={templates.data} />
    </>
  );
}

function Wizard({
  config,
  refetchConfig,
  targets,
  templates,
}: {
  config: AppConfig;
  refetchConfig: () => void;
  targets: NonNullable<ReturnType<typeof useTargets>["data"]>;
  templates: NonNullable<ReturnType<typeof useRuleTemplates>["data"]>;
}) {
  const router = useRouter();
  const connection = useConnection();
  const now = useNow(15_000);
  const nowSec = now === null ? null : Math.floor(now / 1000);

  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [step, setStep] = useState(0);
  const [created, setCreated] = useState<CreatedChallenge | null>(null);
  const [createError, setCreateError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const createSpec = useCreateSpec();
  const createChallenge = useCreateChallenge();

  // ------------------------------------------------------------------ derived state
  const target = targets.find((t) => t.key === draft.targetKey);
  const plan = networkPlan(config, draft);
  const connectedAddress = connection.status === "connected" ? connection.address : undefined;
  const publisher = publisherPlan(draft, plan.offchain, connectedAddress);
  const errors = termsErrors(draft, { target, templates, offchain: plan.offchain, publisher, nowSec });
  const termsValid = !hasErrors(errors);
  const request = buildPreviewRequest(draft, { target, templates, offchain: plan.offchain, publisher, termsValid });
  const requestKey = request ? JSON.stringify(request.body) : null;
  const debouncedKey = useDebounced(requestKey, 400);

  const preview = useQuery({
    queryKey: ["create", "spec-preview", debouncedKey],
    queryFn: () => api.previewSpec(JSON.parse(debouncedKey as string) as SpecRequest),
    enabled: debouncedKey !== null,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 60_000,
    // The same body always previews to the same spec; do not refetch (and flicker) on focus.
    refetchOnWindowFocus: false,
  });
  const fresh =
    requestKey !== null && debouncedKey === requestKey && !!preview.data && !preview.isPlaceholderData && !preview.isFetching;
  const previewError = preview.isError ? preview.error : null;
  const final = !!request?.final;
  const localCheck = useLocalDigestCheck(fresh && final ? preview.data : undefined);

  const selected = selectedTemplates(draft, templates);
  const statementFor = (templateId: string) => preview.data?.spec.rules.find((r) => r.template === templateId)?.statement;

  // ------------------------------------------------------------------ issues per step
  const chain = config.chain;
  const chainIssues: string[] = plan.offchain
    ? []
    : [
        chain.reachable === false ? "The backend cannot reach the chain RPC right now; funding could not be verified." : null,
        chain.chain_id_matches === false ? "The chain RPC reports a different chain id than the backend expects." : null,
        chain.contract_has_code === false ? "There is no contract code at the configured address." : null,
        !config.evaluator_address ? "The backend has no evaluator address configured." : null,
      ].filter((x): x is string => !!x);

  const issues: string[][] = [
    target ? [] : ["Choose a target."],
    selected.length === 0
      ? ["Choose at least one rule."]
      : selected.length > MAX_RULES
        ? [`A spec holds at most ${MAX_RULES} rules.`]
        : selected.some((t) => hasErrors(paramErrors(t, ruleDraft(draft, t))))
          ? ["Fix the highlighted rule parameters."]
          : [],
    previewError && !preview.data
      ? ["The backend could not preview the spec; fix the error shown."]
      : !preview.data
        ? ["Waiting for the backend preview of the spec."]
        : draft.scopeApproved
          ? []
          : ["Approve the scope, limits and evaluator exactly as shown."],
    Object.values(errors).filter((x): x is string => !!x),
    [],
  ];
  const priorIssues = issues.slice(0, 4).flat();
  const reviewIssues = [
    ...priorIssues,
    ...chainIssues,
    previewError ? "The latest preview failed; the spec shown is out of date." : null,
    !previewError && !fresh ? "Waiting for the backend preview to match your latest change." : null,
    localCheck.status === "mismatch" ? "The digest recomputed in this browser differs from the backend's." : null,
  ].filter((x): x is string => !!x);
  const canCreate = reviewIssues.length === 0 && final && fresh && !!preview.data && !created;

  // ------------------------------------------------------------------ actions
  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setRule = (templateId: string, next: RuleDraft) => setDraft((d) => ({ ...d, rules: { ...d.rules, [templateId]: next } }));
  const selectTarget = (key: string) => {
    const defaultDeadline = ceilToMinute(nowSeconds() + DEFAULT_SUBMISSION_LEAD_S);
    setDraft((d) => ({
      ...d,
      targetKey: key,
      scopeApproved: d.targetKey === key ? d.scopeApproved : false,
      submissionDeadline: d.submissionDeadline ?? defaultDeadline,
    }));
  };

  // Move focus to the step heading when the step changes (not on first render).
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef(step);
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    headingRef.current?.focus();
  }, [step]);

  const goTo = (i: number) => setStep(Math.max(0, Math.min(STEPS.length - 1, i)));

  const handleCreate = async () => {
    if (!canCreate || !request || !preview.data) return;
    const reviewed = preview.data.digest;
    setCreating(true);
    setCreateError(null);
    try {
      const stored = await createSpec.mutateAsync(request.body);
      if (stored.digest !== reviewed) {
        throw new Error(
          `The backend stored digest ${stored.digest}, but you reviewed ${reviewed}. No challenge was created and nothing was funded. Review the spec again.`,
        );
      }
      const row = await createChallenge.mutateAsync({ spec_digest: stored.digest });
      setCreated({ challenge: row, spec: stored.spec, digest: stored.digest });
      if (row.status !== "awaiting_funding") router.push(`/challenges/${row.id}`);
    } catch (e) {
      setCreateError(e);
    } finally {
      setCreating(false);
    }
  };

  // ------------------------------------------------------------------ view
  const locked = !!created;
  const stepItems: StepItem[] = STEPS.map((s, i) => ({
    id: s.id,
    label: s.label,
    description: s.description,
    state: locked ? (i < 4 ? "complete" : "current") : i === step ? "current" : i < step ? (issues[i].length ? "warning" : "complete") : "upcoming",
  }));
  const current = STEPS[step];
  const previewView = {
    rules: preview.data?.spec.rules,
    initialState: preview.data?.spec.initial_state,
    fresh,
    error: previewError,
    idle: requestKey === null,
  };

  const action = created ? (
    created.challenge.status === "awaiting_funding" ? (
      <section aria-labelledby="fund-heading" className="space-y-3 rounded-lg border border-line-strong bg-surface p-4 sm:p-5">
        <h3 id="fund-heading" className="text-sm font-semibold text-fg">
          Fund challenge #{created.challenge.id}
        </h3>
        <FundingPanel
          config={config}
          created={created}
          onDiscard={() => {
            setCreated(null);
            setCreateError(null);
          }}
        />
      </section>
    ) : (
      <Callout tone="ok" title={`Created off-chain challenge #${created.challenge.id}`} role="status">
        Opening it now. <ButtonLink href={`/challenges/${created.challenge.id}`} size="sm" variant="secondary">Open challenge</ButtonLink>
      </Callout>
    )
  ) : (
    <section aria-labelledby="publish-heading" className="space-y-3 rounded-lg border border-line-strong bg-surface p-4 sm:p-5">
      <h3 id="publish-heading" className="text-sm font-semibold text-fg">
        Publish
      </h3>
      <p className="text-sm text-muted">
        {plan.offchain
          ? "Stores the spec (content-addressed by its digest) and creates an off-chain, evidence-only challenge."
          : "Stores the spec and creates a challenge awaiting funding. Then your wallet calls createChallenge with the reward; the backend verifies the receipt from the chain before the challenge counts as funded."}
      </p>
      <ReasonList reasons={reviewIssues} />
      {chain.reachable === false && !plan.offchain ? (
        <Button size="sm" variant="ghost" icon={<RefreshCw />} onClick={refetchConfig}>
          Re-check the chain
        </Button>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          icon={<FilePlus2 />}
          onClick={() => void handleCreate()}
          disabled={!canCreate}
          busy={creating}
          busyLabel="Storing the spec"
        >
          {plan.offchain ? "Create off-chain challenge" : "Create challenge, then fund"}
        </Button>
      </div>
      {createError ? <ErrorState compact error={createError} title="Could not create the challenge" /> : null}
    </section>
  );

  return (
    <div className="space-y-6">
      <Stepper steps={stepItems} label="Create challenge steps" />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="min-w-0 space-y-4">
          <div>
            <h2 ref={headingRef} tabIndex={-1} className="scroll-mt-24 text-base font-semibold text-fg outline-none focus-visible:outline-2">
              <span className="text-muted">
                Step {step + 1} of {STEPS.length}:
              </span>{" "}
              {current.label}
            </h2>
            <p className="mt-0.5 text-sm text-muted">{STEP_INTRO[current.id]}</p>
          </div>

          {current.id === "target" ? (
            <StepTarget targets={targets} selectedKey={draft.targetKey} onSelect={selectTarget} config={config} />
          ) : current.id === "rules" ? (
            templates.length === 0 ? (
              <ErrorState error={new Error("GET /api/rule-templates returned no templates.")} title="No rule templates" />
            ) : (
              <StepRules
                templates={templates}
                getRule={(t) => ruleDraft(draft, t)}
                onRuleChange={setRule}
                ruleIdFor={(id) => ruleIdFor(draft, templates, id)}
                preview={previewView}
              />
            )
          ) : current.id === "scope" ? (
            <StepScope
              spec={preview.data?.spec}
              fresh={fresh}
              error={previewError}
              config={config}
              approved={draft.scopeApproved}
              onApprove={(v) => update({ scopeApproved: v })}
            />
          ) : current.id === "terms" ? (
            <StepTerms
              draft={draft}
              update={update}
              setRule={setRule}
              config={config}
              target={target}
              plan={plan}
              publisher={publisher}
              errors={errors}
              connectedAddress={connectedAddress}
              selected={selected.map((t, i) => ({ template: t, rule: ruleDraft(draft, t), id: `R${i + 1}`, statement: statementFor(t.id) }))}
            />
          ) : (
            <StepReview
              preview={created ? { digest: created.digest, spec: created.spec } : preview.data}
              fresh={created ? true : fresh}
              final={created ? true : final}
              error={created ? null : previewError}
              target={target}
              onEdit={goTo}
              locked={locked}
              action={action}
            />
          )}

          <nav aria-label="Wizard navigation" className="flex flex-wrap items-start justify-between gap-3 border-t border-line pt-4">
            <Button icon={<ArrowLeft />} onClick={() => goTo(step - 1)} disabled={step === 0 || locked}>
              Back
            </Button>
            {step < STEPS.length - 1 ? (
              <div className="flex flex-col items-end gap-2">
                <Button variant="primary" onClick={() => goTo(step + 1)} disabled={issues[step].length > 0}>
                  Next: {STEPS[step + 1].label}
                  <ArrowRight aria-hidden="true" className="size-4" />
                </Button>
                <ReasonList reasons={issues[step]} className="max-w-sm" />
              </div>
            ) : null}
          </nav>
        </div>

        <aside aria-label="Challenge summary" className="min-w-0 space-y-3 lg:sticky lg:top-20 lg:self-start">
          <Summary
            draft={draft}
            config={config}
            target={target}
            planOffchain={plan.offchain}
            rules={selected.map((t, i) => ({ id: `R${i + 1}`, title: t.title, eligible: ruleDraft(draft, t).eligible }))}
            digest={created ? created.digest : fresh && final ? preview.data?.digest : undefined}
            createdId={created?.challenge.id}
          />
        </aside>
      </div>
    </div>
  );
}

function Summary({
  draft,
  config,
  target,
  planOffchain,
  rules,
  digest,
  createdId,
}: {
  draft: Draft;
  config: AppConfig;
  target: Target | undefined;
  planOffchain: boolean;
  rules: { id: string; title: string; eligible: boolean }[];
  digest: string | undefined;
  createdId: number | undefined;
}) {
  const wei = rewardWei(draft);
  const rewardText = planOffchain ? "none (off-chain, evidence only)" : wei !== null && wei > BigInt(0) ? formatWei(wei, config.network) : "not set";
  return (
    <div className="rounded-lg border border-line bg-surface p-4 text-sm">
      <h2 className="text-sm font-semibold text-fg">Your challenge</h2>
      <dl className="mt-3 space-y-2.5">
        <div>
          <dt className="text-xs text-muted">Target</dt>
          <dd className="mt-0.5 space-y-1">
            {target ? (
              <>
                <span className="block font-mono text-xs text-fg">{target.key}</span>
                <ProvenanceBadge kind="target" value={target.label} requiresModel={target.requires_model} size="sm" />
              </>
            ) : (
              <span className="text-xs text-subtle">not chosen</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Rules</dt>
          <dd className="mt-0.5">
            {rules.length ? (
              <ul className="space-y-0.5">
                {rules.map((r) => (
                  <li key={r.id} className="text-xs text-fg">
                    <span className="font-mono text-muted">{r.id}</span> {r.title}
                    {!r.eligible ? <span className="text-muted"> (not eligible)</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-xs text-subtle">none selected</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Settlement</dt>
          <dd className="mt-0.5">
            <ProvenanceBadge kind="network" value={planOffchain ? "offchain" : config.network} size="sm" />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Reward</dt>
          <dd className="mt-0.5 text-xs text-fg">{rewardText}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Submissions close</dt>
          <dd className="mt-0.5 font-mono text-xs text-fg">
            {draft.submissionDeadline !== null ? formatUnix(draft.submissionDeadline, { utc: true }) : "not set"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Spec digest</dt>
          <dd className="mt-0.5">
            {digest ? <Digest value={digest} label="spec digest" head={6} tail={4} /> : <span className="text-xs text-subtle">not final yet</span>}
          </dd>
        </div>
        {createdId !== undefined ? (
          <div>
            <dt className="text-xs text-muted">Backend challenge</dt>
            <dd className="mt-0.5 text-xs text-fg">#{createdId}</dd>
          </div>
        ) : null}
      </dl>
      <p className="mt-3 border-t border-line pt-3 text-xs text-muted">
        The evaluator is a declared trusted party. Its signature is an attestation, not a proof.
      </p>
    </div>
  );
}
