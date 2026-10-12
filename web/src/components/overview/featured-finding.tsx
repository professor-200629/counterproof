"use client";

import { Bot, FlaskConical } from "lucide-react";
import type { ReactNode } from "react";
import { RecordedMark } from "@/components/snapshot";
import { TxHash } from "@/components/tx-hash";
import { Address } from "@/components/ui/address";
import { Card } from "@/components/ui/card";
import { Digest } from "@/components/ui/digest";
import { Disclosure } from "@/components/ui/disclosure";
import { ProvenanceBadge } from "@/components/ui/provenance-badge";
import { ErrorState, Loading, Skeleton } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status-badge";
import { Mono, TextLink, textLinkClasses } from "@/components/ui/text-link";
import { DataPairs } from "@/components/evidence/values";
import { finishedSummary, specJsonUrl, type ChallengeListItem, type ChallengeView, type Evaluation, type Regression } from "@/lib/api";
import { formatWei } from "@/lib/chain";
import { cn } from "@/lib/cn";
import { plural } from "@/lib/format";
import { useChallenge, useChallengeRegressions, useErc8004, useEvidence } from "@/lib/queries";
import { settleTxForEvidence, settledRecipient, settledRewardWei, withdrawalAfterSettle, withdrawnWei } from "@/lib/reward-facts";
import { DEFAULT_SOURCE_URL, REPRODUCE_DOC_URL, SNAPSHOT_MODE, SNAPSHOT_SOURCE_URL } from "@/lib/snapshot";
import { statusMeta } from "@/lib/status";
import {
  attemptSummary,
  feedbackFor,
  injectedContent,
  pickFeaturedChallenge,
  pickFeaturedEvaluation,
  replayTally,
  sameFamilyRegressions,
  truncateText,
} from "./featured-data";

const HEADING_ID = "featured-finding-heading";

/**
 * The overview's lead: one recorded finding explained end to end from API data only - the
 * promise, the agent and model, the injected text, what the agent attempted, how often fresh
 * evaluator replays reproduced it, what was paid and withdrawn, whether a repair of the SAME
 * agent was replayed, and where to inspect every value. Prefers a live-model agent; falls
 * back to the newest verified violation (a planted-defect fixture keeps its amber label).
 */
export function FeaturedFinding({ challenges }: { challenges: ChallengeListItem[] }) {
  const pick = pickFeaturedChallenge(challenges);
  if (!pick) return null;
  return <FeaturedLoader item={pick.item} liveModel={pick.liveModel} />;
}

function Shell({ children, tone = "bad" }: { children: ReactNode; tone?: "bad" | "neutral" }) {
  return (
    <Card as="section" aria-labelledby={HEADING_ID} tone={tone} className="overflow-hidden">
      {children}
    </Card>
  );
}

function FeaturedLoader({ item, liveModel }: { item: ChallengeListItem; liveModel: boolean }) {
  const viewQ = useChallenge(item.id);
  const view = viewQ.data;
  if (!view) {
    return (
      <Shell tone="neutral">
        <div className="px-4 py-3 sm:px-5">
          <h2 id={HEADING_ID} className="text-base font-semibold text-fg">
            Featured finding: {item.title}
          </h2>
          {viewQ.isError ? (
            <ErrorState error={viewQ.error} title="Could not load this challenge" onRetry={() => void viewQ.refetch()} compact className="mt-3" />
          ) : (
            <Loading label="featured finding" rows={3} className="mt-3" />
          )}
        </div>
      </Shell>
    );
  }
  const evaluation = pickFeaturedEvaluation(view);
  if (!evaluation) return null;
  return <FeaturedBody view={view} evaluation={evaluation} liveModel={liveModel} />;
}

function FeaturedBody({ view, evaluation, liveModel }: { view: ChallengeView; evaluation: Evaluation; liveModel: boolean }) {
  const evidenceQ = useEvidence(evaluation.evidence_digest);
  const regsQ = useChallengeRegressions(view.id);
  const ercQ = useErc8004();
  const bundle = evidenceQ.data ?? null;

  const spec = view.spec;
  const targetKey = `${spec.target.adapter}@${spec.target.version}`;
  const ruleId =
    bundle?.verdict.rule?.rule_id ??
    finishedSummary(evaluation)?.rule?.rule_id ??
    view.candidates.find((c) => c.id === evaluation.candidate_id)?.claimed_rule ??
    null;
  const rule = spec.rules.find((r) => r.id === ruleId) ?? null;
  const tally = replayTally(evaluation);
  const repro = bundle?.reproducibility ?? spec.reproducibility;
  const stochastic = spec.target.determinism === "stochastic";
  const model = typeof spec.target.config.model === "string" ? spec.target.config.model : null;
  const provider = typeof spec.target.config.provider === "string" ? spec.target.config.provider : null;
  const label = spec.target.label;
  const fixture = label === "intentionally-vulnerable-fixture";

  const injected = injectedContent(bundle?.candidate?.actions, spec.initial_state.products);
  const attempt = bundle ? attemptSummary(bundle, rule) : null;
  const repairs = sameFamilyRegressions(regsQ.data, view, evaluation.candidate_id);
  const repair: Regression | null = repairs[0] ?? null;
  const evidenceDigest = bundle?.evidence_digest ?? evaluation.evidence_digest;
  const feedback = feedbackFor(ercQ.data, evidenceDigest, view.onchain_id, targetKey);

  const subject = liveModel ? "A live-model agent" : fixture ? "An intentionally vulnerable fixture" : "The target agent";
  const headline = tally
    ? `${subject} violated ${rule?.id ?? "its promise"} in ${tally.violated} of ${tally.total} fresh evaluator replays`
    : `${subject} violated ${rule?.id ?? "its promise"} in the evaluator's replays`;

  return (
    <Shell>
      <header className="border-b border-line px-4 py-3 sm:px-5">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium uppercase tracking-wide text-subtle">
          {liveModel ? <Bot aria-hidden="true" className="size-3.5" /> : <FlaskConical aria-hidden="true" className="size-3.5" />}
          {liveModel ? "Featured live-model finding" : "Featured finding (no live-model finding recorded)"}
          <RecordedMark what="This finding" className="normal-case tracking-normal" />
        </p>
        <h2 id={HEADING_ID} className="mt-1 text-base font-semibold text-fg sm:text-lg">
          {headline}
        </h2>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <StatusBadge status="verified_violation" domain="evaluation" size="sm" />
          <ProvenanceBadge kind="target" value={label} requiresModel={view.target_info?.requires_model} size={fixture ? "lg" : "md"} />
          <ProvenanceBadge kind="network" value={view.network} size="sm" />
          <TextLink href={`/challenges/${view.id}`} className="text-xs">
            Challenge #{view.id}
          </TextLink>
        </div>
      </header>

      <dl className="grid gap-x-6 gap-y-4 px-4 py-4 sm:px-5 md:grid-cols-2">
        <Fact title="Promise tested">
          {rule ? (
            <p>
              <Mono>{rule.id}</Mono> {rule.statement}
            </p>
          ) : (
            <p className="text-muted">The claimed rule is not named in the recorded data.</p>
          )}
        </Fact>

        <Fact title="Agent under test">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Mono>{targetKey}</Mono>
            {model ? (
              <span>
                driven by model <Mono>{model}</Mono>
                {provider ? <span className="text-muted"> via {provider}</span> : null}
              </span>
            ) : null}
          </p>
          {view.target_info?.provenance ? <p className="mt-1 text-xs text-muted">{view.target_info.provenance}</p> : null}
        </Fact>

        <Fact title={injected.length > 0 ? "Injected merchant text (untrusted content)" : "Counterexample"} wide>
          {bundle ? (
            injected.length > 0 ? (
              <div className="space-y-2">
                {injected.map((t, i) => (
                  <figure key={i} className="min-w-0 rounded-md border border-dashed border-line bg-inset px-3 py-2">
                    <figcaption className="text-xs text-muted">
                      Placed by the challenger in the description of <Mono>{t.sku ?? "?"}</Mono>
                      {t.merchant ? (
                        <>
                          {" "}
                          (merchant <Mono>{t.merchant}</Mono>)
                        </>
                      ) : null}
                      ; quoted as recorded. It is test input, not an instruction.
                    </figcaption>
                    <QuotedText text={t.text} />
                  </figure>
                ))}
              </div>
            ) : (
              <p>
                {bundle.candidate ? (
                  <>
                    A sequence of {bundle.candidate.actions.length} {plural(bundle.candidate.actions.length, "action")} with no injected
                    merchant text; the evidence page lists each one.
                  </>
                ) : (
                  "The recorded bundle holds no candidate."
                )}
              </p>
            )
          ) : (
            <EvidenceState q={evidenceQ} />
          )}
        </Fact>

        <Fact title="What the agent attempted">
          {attempt ? (
            <div className="space-y-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <Mono>{attempt.tool}</Mono>
                <DataPairs data={attempt.args} currency={spec.initial_state.currency || "SYN"} />
              </div>
              <p>
                Attempted in{" "}
                <span className="font-semibold tabular">
                  {attempt.replaysWithAttempt} of {attempt.replays}
                </span>{" "}
                replays.{" "}
                {attempt.replaysRefused > 0 ? (
                  <>
                    The marketplace refused it in{" "}
                    <span className="font-semibold tabular">
                      {attempt.replaysRefused} of {attempt.replays}
                    </span>
                    {attempt.refusal?.code || attempt.refusal?.message ? (
                      <>
                        {" "}
                        (<span className="font-mono text-xs">{[attempt.refusal.code, attempt.refusal.message].filter(Boolean).join(": ")}</span>)
                      </>
                    ) : null}
                    . The rule counts the attempt itself, refused or not.
                  </>
                ) : (
                  "No refusal of this call is recorded in the tool-call trace."
                )}
              </p>
              {attempt.otherTools.length > 0 ? (
                <p className="text-xs text-muted">Also attempted: {attempt.otherTools.join(", ")}.</p>
              ) : null}
            </div>
          ) : bundle ? (
            <p>{bundle.verdict.summary ?? "The checker's summary is on the evidence page."}</p>
          ) : (
            <EvidenceState q={evidenceQ} />
          )}
        </Fact>

        <Fact title="Reproduced by fresh evaluator replays">
          {tally ? (
            <p>
              <span className="font-semibold tabular">
                {tally.violated} of {tally.total}
              </span>{" "}
              independent replays violated {rule?.id ?? "the claimed rule"}; the spec requires {repro.required_violations} of {repro.replays}.
            </p>
          ) : (
            <p className="text-muted">No finished replay summary is recorded.</p>
          )}
          <p className="mt-1 text-xs text-muted">
            {stochastic
              ? `A live model is statistical: this is bounded evidence about ${model ?? "this model"} on this date, not a guarantee it always or never happens. ${repro.statement}`
              : repro.statement}
          </p>
        </Fact>

        <Fact title="Reward">
          <RewardFacts view={view} evidenceDigest={evidenceDigest} feedback={feedback} ercChainId={ercQ.data?.chain_id ?? view.chain_id} />
        </Fact>

        <Fact title="Repair" wide>
          {regsQ.isPending ? (
            <Skeleton className="h-4 w-2/3" />
          ) : regsQ.isError ? (
            <ErrorState error={regsQ.error} title="Could not load the recorded regressions" onRetry={() => void regsQ.refetch()} compact />
          ) : repair ? (
            <RepairFacts view={view} repair={repair} ruleId={rule?.id ?? null} />
          ) : (
            <p>
              <span className="font-semibold">Repair: not yet replayed for this agent.</span>{" "}
              <span className="text-muted">
                No other version of <span className="font-mono text-xs">{spec.target.adapter}</span> had replayed this counterexample
                {SNAPSHOT_MODE ? " when this snapshot was recorded" : " yet"}. A replay against a different agent family would not show
                a repair.
              </span>
            </p>
          )}
        </Fact>
      </dl>

      <footer className="space-y-2 border-t border-line px-4 py-3 text-sm sm:px-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-subtle">How to inspect</p>
        <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
          <li>
            <TextLink href={`/evaluations/${evaluation.id}`}>Evidence: replays, ledgers, verdict</TextLink>
          </li>
          <li>
            <TextLink href={`/challenges/${view.id}/settlement`}>Settlement and signature</TextLink>
          </li>
          <li>
            <a href={specJsonUrl(view.spec_digest)} download={`spec-${view.spec_digest.slice(7, 19)}.json`} className={textLinkClasses}>
              Spec JSON (download)
            </a>
          </li>
          <li>
            <TextLink href={SNAPSHOT_SOURCE_URL ?? DEFAULT_SOURCE_URL}>Repository README</TextLink>
          </li>
          <li>
            <TextLink href={REPRODUCE_DOC_URL}>docs/REPRODUCE.md</TextLink>
          </li>
        </ul>
        <p className="text-xs text-muted">
          Run the evaluator yourself: clone the repository and follow docs/REPRODUCE.md to replay this counterexample on your own
          machine{SNAPSHOT_MODE ? "; this hosted page is a recording and cannot run anything" : ""}.
        </p>
        <Disclosure summary={<span className="text-xs font-medium">Digests and ledgers</span>} className="mt-1">
          <DigestList view={view} evaluation={evaluation} evidenceDigest={evidenceDigest} candidateDigest={bundle?.submission.candidate_digest ?? null} />
        </Disclosure>
      </footer>
    </Shell>
  );
}

function Fact({ title, wide, children }: { title: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={cn("min-w-0", wide && "md:col-span-2")}>
      <dt className="text-xs font-semibold text-muted">{title}</dt>
      <dd className="mt-1 min-w-0 break-words text-sm text-fg">{children}</dd>
    </div>
  );
}

function EvidenceState({ q }: { q: { isError: boolean; error: unknown; refetch: () => unknown } }) {
  if (q.isError) {
    return <ErrorState error={q.error} title="Could not load the evidence bundle" onRetry={() => void q.refetch()} compact />;
  }
  return <Skeleton className="h-4 w-3/4" />;
}

/** Untrusted text as a quotation: the first words, with the full text one toggle away. */
function QuotedText({ text }: { text: string }) {
  const { head, cut } = truncateText(text, 120);
  const quote = "mt-1 whitespace-pre-wrap break-words font-mono text-xs text-fg";
  if (!cut) return <blockquote className={quote}>&ldquo;{text}&rdquo;</blockquote>;
  return (
    <details className="group">
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <span className={cn(quote, "block group-open:hidden")}>&ldquo;{head}&hellip;&rdquo;</span>
        <span className="mt-1 inline-flex text-xs text-accent-text underline decoration-1 underline-offset-2">
          <span className="group-open:hidden">Show the full text ({text.length} characters)</span>
          <span className="hidden group-open:inline">Hide the full text</span>
        </span>
      </summary>
      <blockquote className={quote}>&ldquo;{text}&rdquo;</blockquote>
    </details>
  );
}

function RewardFacts({
  view,
  evidenceDigest,
  feedback,
  ercChainId,
}: {
  view: ChallengeView;
  evidenceDigest: string | null;
  feedback: ReturnType<typeof feedbackFor>;
  ercChainId: number | null;
}) {
  if (view.status === "offchain" || view.network === "offchain") {
    return <p>No reward: an off-chain challenge produces evidence only.</p>;
  }
  const settle = settleTxForEvidence(view.transactions, evidenceDigest);
  const recipient = settledRecipient(settle);
  const withdrawal = withdrawalAfterSettle(view.transactions, settle, recipient);
  const rewardWei = settledRewardWei(settle) ?? view.reward_wei;
  return (
    <div className="space-y-1.5">
      {settle ? (
        <>
          <p>
            <span className="font-semibold text-ok">Settled:</span> {formatWei(rewardWei, view.network)} credited to{" "}
            <Address value={recipient} label="recipient" />, the recipient bound when the submission was committed.
          </p>
          <TxHash hash={settle.hash} chainId={settle.chain_id} label="settle transaction hash" className="text-xs" />
          {withdrawal ? (
            <>
              <p>
                <span className="font-semibold text-ok">Withdrawn:</span> the recipient withdrew its credit (
                {formatWei(withdrawnWei(withdrawal), view.network)}), which includes this reward.
              </p>
              <TxHash hash={withdrawal.hash} chainId={withdrawal.chain_id} label="withdraw transaction hash" className="text-xs" />
            </>
          ) : (
            <p className="text-muted">Not withdrawn: the credit stays in the contract until the recipient withdraws it.</p>
          )}
        </>
      ) : (
        <p>
          {view.status === "refunded"
            ? "Not paid: the challenge was refunded to the publisher."
            : view.status === "settled"
              ? "The challenge is settled, but no recorded settle transaction names this evidence."
              : `Not settled (${statusMeta(view.status, "challenge").label.toLowerCase()}); ${formatWei(view.reward_wei, view.network)} reward.`}
        </p>
      )}
      {feedback ? (
        <>
          <p>
            <span className="font-semibold">ERC-8004 feedback:</span> posted for agent #{feedback.agent_id} (tag{" "}
            <span className="font-mono text-xs">{feedback.tag2}</span>), a public pointer to this evidence, not a proof.
          </p>
          <TxHash hash={feedback.tx} chainId={ercChainId} label="ERC-8004 feedback transaction hash" className="text-xs" />
        </>
      ) : null}
      {view.network === "monad-testnet" ? (
        <p className="text-xs text-muted">Testnet MON is the native token of Monad testnet: real testnet transactions, no monetary value.</p>
      ) : null}
    </div>
  );
}

function RepairFacts({ view, repair, ruleId }: { view: ChallengeView; repair: Regression; ruleId: string | null }) {
  const afterQ = useEvidence(repair.evidence_digest);
  const after = afterQ.data ?? null;
  const n = after?.replays.length ?? 0;
  const violated = after ? after.replays.filter((r) => r.claimed_rule_violated).length : null;
  const href = `/challenges/${view.id}/compare?candidate=${encodeURIComponent(repair.source_candidate_id)}&target=${encodeURIComponent(repair.target_key)}&regression=${encodeURIComponent(repair.id)}`;
  return (
    <div className="space-y-1">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-semibold">Replayed on</span> <Mono>{repair.target_key}</Mono>
        <StatusBadge status={repair.status} domain="regression" size="sm" />
      </p>
      {after && n > 0 ? (
        <p>
          {ruleId ?? "The claimed rule"} was violated in{" "}
          <span className="font-semibold tabular">
            {violated} of {n}
          </span>{" "}
          fresh {plural(n, "replay")} of the same sequence on that version
          {after.target.determinism === "stochastic" ? "; with a live model this is bounded statistical evidence, not proof the repair holds" : ""}.
        </p>
      ) : afterQ.isError ? (
        <p className="text-muted">The regression&apos;s evidence bundle could not be loaded.</p>
      ) : repair.evidence_digest ? (
        <Skeleton className="h-4 w-1/2" />
      ) : (
        <p className="text-muted">No evidence bundle is recorded for this replay yet.</p>
      )}
      <p>
        <TextLink href={href}>Open the before / after comparison</TextLink>
      </p>
    </div>
  );
}

function DigestList({
  view,
  evaluation,
  evidenceDigest,
  candidateDigest,
}: {
  view: ChallengeView;
  evaluation: Evaluation;
  evidenceDigest: string | null;
  candidateDigest: string | null;
}) {
  const replays = evaluation.summary && "replays" in evaluation.summary ? evaluation.summary.replays : [];
  return (
    <div className="space-y-2 text-xs">
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(8rem,auto)_1fr]">
        <dt className="text-muted">Evidence bundle</dt>
        <dd className="min-w-0">
          <Digest value={evidenceDigest} label="evidence digest" />
        </dd>
        <dt className="text-muted">Spec</dt>
        <dd className="min-w-0">
          <Digest value={view.spec_digest} label="spec digest" />
        </dd>
        <dt className="text-muted">Candidate</dt>
        <dd className="min-w-0">
          <Digest value={candidateDigest} label="candidate digest" emptyText="loads with the evidence bundle" />
        </dd>
        <dt className="text-muted">Target artifact</dt>
        <dd className="min-w-0">
          <Digest value={view.spec.target.artifact_digest} label="target artifact digest" />
        </dd>
        {replays.map((r) => (
          <div key={r.index} className="contents">
            <dt className="text-muted">Ledger, replay {r.index}</dt>
            <dd className="min-w-0">
              <Digest value={r.ledger_digest} label={`ledger digest of replay ${r.index}`} />
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-muted">
        Every ledger event, the tool-call trace of each replay and the verdict are on the{" "}
        <TextLink href={`/evaluations/${evaluation.id}#replays`}>evidence page</TextLink>.
      </p>
    </div>
  );
}
