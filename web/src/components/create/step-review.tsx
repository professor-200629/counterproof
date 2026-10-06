"use client";

import { useQuery } from "@tanstack/react-query";
import { BadgeCheck, CircleAlert, Pencil, ShieldQuestion } from "lucide-react";
import type { ReactNode } from "react";
import { LLM_NEVER_DECIDES, NOT_PROOF_OF_SAFETY } from "@/components/truth";
import {
  Address,
  Badge,
  Button,
  Callout,
  Countdown,
  DateTime,
  Digest,
  ErrorState,
  JsonView,
  KeyValueList,
  Loading,
  ProvenanceBadge,
} from "@/components/ui";
import type { SpecResponse, Target } from "@/lib/api";
import { ATTESTATION_MEANING, RECEIPT_MEANING, digestToBytes32, formatWei, networkForChainId, txNetworkPhrase } from "@/lib/chain";
import { formatUnix } from "@/lib/format";
import { Block, UpdatingNote } from "./bits";
import { canHashLocally, canonicalJson, sha256Text } from "./canonical";

export interface StepReviewProps {
  preview: SpecResponse | undefined;
  /** The preview matches the current draft exactly. */
  fresh: boolean;
  /** The draft has no stand-in values (publisher, terms). */
  final: boolean;
  error: unknown;
  target: Target | undefined;
  onEdit: (step: number) => void;
  /** Disable the edit links (e.g. once the spec is stored and funding started). */
  locked: boolean;
  /** Primary action area (create + fund). */
  action: ReactNode;
}

/** Step 5: the exact canonical spec, its digest, what a payout requires and what results do not mean. */
export function StepReview({ preview, fresh, final, error, target, onEdit, locked, action }: StepReviewProps) {
  if (error && !preview) return <ErrorState error={error} title="The backend could not build the spec preview" />;
  if (!preview) return <Loading label="spec preview" rows={8} card />;

  const { spec } = preview;
  const onchain = spec.settlement !== null;
  const network = networkForChainId(spec.settlement?.chain_id);
  const ruleById = new Map(spec.rules.map((r) => [r.id, r]));
  const eligible = spec.reward.eligible_rules.map((id) => ruleById.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
  const notEligible = spec.rules.filter((r) => !spec.reward.eligible_rules.includes(r.id));
  const repro = spec.reproducibility;
  const settled = fresh && final;

  const edit = (step: number, what: string) =>
    locked ? null : (
      <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => onEdit(step)} aria-label={`Edit ${what}`}>
        Edit
      </Button>
    );

  return (
    <div className="space-y-4">
      {!settled ? (
        <Callout tone="warn" icon={<CircleAlert />} title="Not final yet">
          {!final
            ? "Some values are still missing or invalid (see the list below), so this preview used a stand-in. Its digest is not the one that would be published."
            : "The preview is catching up with your latest change."}{" "}
          <UpdatingNote show={!fresh && !error} />
        </Callout>
      ) : null}
      {error ? <ErrorState compact error={error} title="The latest preview failed; showing the previous one" /> : null}

      <Block title="What a payout requires" actions={edit(3, "reward and deadlines")}>
        {onchain ? (
          <div className="space-y-2 text-sm text-fg">
            <p>
              The contract credits <strong className="font-semibold">{formatWei(spec.reward.amount_wei, network)}</strong> once
              (policy <span className="font-mono text-xs">{spec.reward.policy}</span>) to the recipient bound at commit time.
            </p>
            <p className="font-medium">The contract checks:</p>
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                the attestation is signed by the declared trusted evaluator <Address value={spec.evaluator.address} label="evaluator address" />{" "}
                ({spec.evaluator.name});
              </li>
              <li>
                its verdict is <span className="font-medium">verified violation</span>;
              </li>
              <li>
                the candidate was committed on chain by <DateTime ts={spec.deadlines.submission_deadline} className="font-medium" />;
              </li>
              <li>
                it is settled by <DateTime ts={spec.deadlines.settlement_deadline} className="font-medium" />;
              </li>
              <li>the payout goes to the recipient bound at commit time.</li>
            </ol>
            <p className="font-medium">The evaluator attests, and you trust it:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                it replayed the challenger&apos;s exact action sequence in fresh synthetic marketplaces, and {repro.required_violations}{" "}
                of {repro.replays} replays violated the rule ({repro.mode});
              </li>
              <li>
                the violated rule is{" "}
                {eligible.length === spec.rules.length ? "a rule in the spec" : `rule ${eligible.map((r) => r.id).join(", ")}`}, as the
                reward policy requires.
              </li>
            </ul>
            <p className="text-muted">The contract cannot see or re-run the replays; it checks only the signature and the fields above.</p>
            <p className="text-muted">
              Anyone may relay the settlement, but the reward always goes to the recipient the challenger bound when committing.
              If nothing is settled by the settlement deadline, you can refund the reward. Network:{" "}
              {txNetworkPhrase(spec.settlement?.chain_id)}.
            </p>
          </div>
        ) : (
          <p className="text-sm text-fg">
            No reward is paid: this is an off-chain, evidence-only challenge. A verified violation produces an evidence bundle from
            the evaluator&apos;s replay. No attestation is signed, no contract is involved and nothing is paid.
          </p>
        )}
        <p className="text-xs text-muted">{LLM_NEVER_DECIDES}</p>
      </Block>

      <Block title="What is promised" actions={edit(1, "rules")}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-fg">
            {spec.target.adapter}@{spec.target.version}
          </span>
          <ProvenanceBadge kind="target" value={spec.target.label} requiresModel={target?.requires_model} />
          {edit(0, "target")}
        </div>
        <ul className="space-y-1.5">
          {spec.rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-start gap-2 text-sm">
              <Badge size="sm" tone="neutral">
                {r.id}
              </Badge>
              <span className="min-w-0 flex-1 text-fg">{r.statement}</span>
              <span className="font-mono text-xs text-muted">{r.template}</span>
              {spec.reward.eligible_rules.includes(r.id) ? null : (
                <span className="text-xs text-muted">{onchain ? "(not eligible for the reward)" : "(not eligible)"}</span>
              )}
            </li>
          ))}
        </ul>
        {notEligible.length > 0 && onchain ? (
          <p className="text-xs text-muted">Non-eligible rules are still checked and reported; a violation of them cannot be paid.</p>
        ) : null}
      </Block>

      <Block title="Terms" actions={edit(3, "terms")}>
        <KeyValueList
          items={[
            { key: "title", label: "Title", value: spec.title },
            {
              key: "publisher",
              label: "Publisher",
              value: (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <Address value={spec.publisher.address} label="publisher address" full />
                  {spec.publisher.name ? <span className="text-muted">{spec.publisher.name}</span> : null}
                  {!final && spec.publisher.address === "0x0000000000000000000000000000000000000000" ? (
                    <span className="text-xs text-warn">stand-in, not bound yet</span>
                  ) : null}
                </span>
              ),
            },
            {
              key: "settlement",
              label: "Settlement",
              value: spec.settlement ? (
                <span>
                  {spec.settlement.network} (chain {spec.settlement.chain_id}), contract{" "}
                  <Address value={spec.settlement.contract} label="contract address" />
                </span>
              ) : (
                "Off-chain only - no contract, no reward"
              ),
            },
            {
              key: "reward",
              label: "Reward",
              value: onchain ? (
                <span>
                  {formatWei(spec.reward.amount_wei, network)}{" "}
                  <span className="font-mono text-xs text-muted">({spec.reward.amount_wei} wei)</span>
                </span>
              ) : (
                spec.reward.currency
              ),
            },
            {
              key: "sub",
              label: "Submission deadline",
              value: (
                <span>
                  <DateTime ts={spec.deadlines.submission_deadline} />{" "}
                  <span className="font-mono text-xs text-muted">({formatUnix(spec.deadlines.submission_deadline, { utc: true })})</span>{" "}
                  <Countdown to={spec.deadlines.submission_deadline} prefix="closes in" className="text-xs" />
                </span>
              ),
            },
            {
              key: "settle",
              label: "Settlement deadline",
              value: (
                <span>
                  <DateTime ts={spec.deadlines.settlement_deadline} />{" "}
                  <span className="font-mono text-xs text-muted">({formatUnix(spec.deadlines.settlement_deadline, { utc: true })})</span>
                </span>
              ),
            },
            {
              key: "evaluator",
              label: "Evaluator",
              value: (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <Address value={spec.evaluator.address} label="evaluator address" full />
                  <Badge size="sm" tone="neutral">
                    {spec.evaluator_trust}
                  </Badge>
                  {!locked ? (
                    <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => onEdit(2)} aria-label="Review scope and evaluator">
                      Scope
                    </Button>
                  ) : null}
                </span>
              ),
            },
          ]}
        />
      </Block>

      <Block title="What results will and will not mean">
        <ul className="space-y-2 text-sm text-fg">
          <TruthItem>
            {NOT_PROOF_OF_SAFETY} If challengers find nothing, the result states the tested version, the rules, how many sequences
            were tried, the search budget, why the search stopped and its limitations - never that the agent is safe.
          </TruthItem>
          <TruthItem>{ATTESTATION_MEANING} CounterProof is not trustless: you are trusting this evaluator.</TruthItem>
          <TruthItem>{RECEIPT_MEANING}</TruthItem>
          <TruthItem>{LLM_NEVER_DECIDES}</TruthItem>
          {spec.target.label === "intentionally-vulnerable-fixture" ? (
            <TruthItem>
              This target is an intentionally vulnerable fixture with planted defects. Findings against it are demonstrations, not
              discoveries.
            </TruthItem>
          ) : null}
          {spec.target.determinism === "stochastic" ? (
            <TruthItem>
              This target is driven by a live hosted model. Verdicts are statistical evidence about that model on that date, not a
              deterministic proof.
            </TruthItem>
          ) : null}
        </ul>
      </Block>

      <Block
        title="Canonical spec"
        description="Exactly what will be stored and, on chain, committed by digest. Keys are sorted and hashed with SHA-256 by the backend."
      >
        <SpecDigest preview={preview} settled={settled} />
        <JsonView value={spec} label={`Challenge spec ${spec.format}`} collapsedDepth={1} maxHeight="32rem" />
      </Block>

      <div id="publish" className="scroll-mt-20">
        {action}
      </div>
    </div>
  );
}

function TruthItem({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2">
      <ShieldQuestion aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-subtle" />
      <span>{children}</span>
    </li>
  );
}

export type LocalDigestCheck =
  | { status: "unsupported" }
  | { status: "pending" }
  | { status: "error"; error: unknown }
  | { status: "match"; local: string }
  | { status: "mismatch"; local: string };

/** Recompute the spec digest in the browser (shared query, so callers agree). */
export function useLocalDigestCheck(preview: SpecResponse | undefined): LocalDigestCheck {
  const supported = canHashLocally();
  let canonical: string | null = null;
  let canonicalError: unknown = null;
  if (preview) {
    try {
      canonical = canonicalJson(preview.spec);
    } catch (e) {
      canonicalError = e;
    }
  }
  // Keyed by the canonical text itself, so a cached result can never vouch for other content.
  const local = useQuery({
    queryKey: ["create", "local-digest", canonical],
    queryFn: () => sha256Text(canonical as string),
    enabled: supported && canonical !== null,
    staleTime: Infinity,
    retry: false,
  });
  if (!supported) return { status: "unsupported" };
  if (canonicalError) return { status: "error", error: canonicalError };
  if (local.isError) return { status: "error", error: local.error };
  if (!local.data || !preview) return { status: "pending" };
  return local.data === preview.digest ? { status: "match", local: local.data } : { status: "mismatch", local: local.data };
}

function SpecDigest({ preview, settled }: { preview: SpecResponse; settled: boolean }) {
  const digest = preview.digest;
  const check = useLocalDigestCheck(preview);
  return (
    <div className="space-y-2 rounded-md border border-line bg-inset p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Spec digest{settled ? "" : " (preview, not final)"}</span>
        <Digest value={digest} label="spec digest" full className="min-w-0" />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>As bytes32 for createChallenge</span>
        <Digest value={digestToBytes32(digest)} label="spec digest as bytes32" head={10} tail={8} />
      </div>
      <p className="flex flex-wrap items-center gap-1.5 text-xs" role="status">
        {check.status === "unsupported" ? (
          <span className="text-muted">This browser cannot compute SHA-256 here (not a secure context), so the digest was not re-checked.</span>
        ) : check.status === "pending" ? (
          <span className="text-muted">Recomputing the digest in this browser...</span>
        ) : check.status === "error" ? (
          <span className="text-warn">Could not recompute the digest in this browser: {String(check.error)}</span>
        ) : check.status === "match" ? (
          <>
            <BadgeCheck aria-hidden="true" className="size-3.5 text-ok" />
            <span className="text-ok">Recomputed in this browser from the canonical JSON: matches the backend&apos;s digest.</span>
          </>
        ) : (
          <>
            <CircleAlert aria-hidden="true" className="size-3.5 text-bad" />
            <span className="text-bad">
              Recomputed in this browser as <span className="font-mono">{check.local}</span>, which differs from the backend&apos;s
              digest. Do not publish; report this.
            </span>
          </>
        )}
      </p>
    </div>
  );
}
