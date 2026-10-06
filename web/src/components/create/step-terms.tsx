"use client";

import { FileText, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { WalletButton } from "@/components/shell/wallet-button";
import { MonadReserveNotice } from "@/components/tx-status";
import { Address, Button, Callout, Checkbox, Countdown, DateTime, Field, Input, NumberField, ProvenanceBadge } from "@/components/ui";
import type { AppConfig, RuleTemplate, Target } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatUnix } from "@/lib/format";
import { Block } from "./bits";
import {
  DEFAULT_SUBMISSION_LEAD_S,
  MAX_WINDOW_MIN,
  MIN_WINDOW_MIN,
  PUBLISHER_NAME_MAX,
  TITLE_MAX,
  ceilToMinute,
  defaultTitle,
  effectiveTitle,
  formatWindow,
  fromLocalInputValue,
  nowSeconds,
  rewardWei,
  settlementDeadline,
  toLocalInputValue,
  type Draft,
  type NetworkPlan,
  type PublisherPlan,
  type RuleDraft,
  type TermsErrors,
} from "./draft";

export interface SelectedRule {
  template: RuleTemplate;
  rule: RuleDraft;
  id: string;
  statement: string | undefined;
}

export interface StepTermsProps {
  draft: Draft;
  update: (patch: Partial<Draft>) => void;
  setRule: (templateId: string, next: RuleDraft) => void;
  config: AppConfig | undefined;
  target: Target | undefined;
  plan: NetworkPlan;
  publisher: PublisherPlan;
  errors: TermsErrors;
  selected: SelectedRule[];
  connectedAddress: string | undefined;
}

const DEADLINE_PRESETS: { label: string; seconds: number }[] = [
  { label: "30 min", seconds: DEFAULT_SUBMISSION_LEAD_S },
  { label: "2 h", seconds: 2 * 3600 },
  { label: "1 day", seconds: 86400 },
  { label: "7 days", seconds: 7 * 86400 },
];

const WINDOW_PRESETS: { label: string; minutes: number }[] = [
  { label: "30 min", minutes: 30 },
  { label: "2 h", minutes: 120 },
  { label: "1 day", minutes: 1440 },
  { label: "7 days", minutes: 7 * 1440 },
  { label: "30 days", minutes: MAX_WINDOW_MIN },
];

/** Step 4: title, settlement mode, publisher, reward, deadlines and payout-eligible rules. */
export function StepTerms({ draft, update, setRule, config, target, plan, publisher, errors, selected, connectedAddress }: StepTermsProps) {
  const deadlineId = useId();
  const network = config?.network;
  const wei = rewardWei(draft);
  const settle = settlementDeadline(draft);
  const chain = config?.chain;
  const rewardLabel =
    network === "monad-testnet" ? "Reward (MON)" : network === "anvil-local" ? "Reward (local anvil test value, not MON)" : "Reward";

  const setDeadlineFromNow = (seconds: number) => update({ submissionDeadline: ceilToMinute(nowSeconds() + seconds) });

  return (
    <div className="space-y-4">
      <Block title="Title and publisher">
        <div className="grid gap-4 md:grid-cols-2">
          <Input
            label="Title"
            value={effectiveTitle(draft, target)}
            onChange={(e) => update({ title: e.target.value })}
            maxLength={TITLE_MAX}
            required
            error={errors.title}
            hint={draft.title === null ? `Suggested from the target; edit freely. ${TITLE_MAX} characters at most.` : undefined}
            placeholder={defaultTitle(target)}
          />
          <Input
            label="Publisher name (optional)"
            value={draft.publisherName}
            onChange={(e) => update({ publisherName: e.target.value })}
            maxLength={PUBLISHER_NAME_MAX}
            error={errors.publisherName}
            hint="Shown in the spec next to your address."
          />
        </div>
      </Block>

      <Block
        title="Settlement"
        description="Where the reward is escrowed and paid."
        actions={config ? <ProvenanceBadge kind="network" value={config.network} /> : null}
      >
        <Checkbox
          checked={plan.offchain}
          disabled={plan.forced}
          onChange={(e) => update({ offchainChoice: e.target.checked })}
          label="Off-chain (evidence only, no reward)"
          description={
            plan.forced
              ? `Required: ${plan.reason}`
              : "No contract and no reward. The evaluator still replays candidates and records evidence bundles; no attestation is signed and nothing is paid."
          }
        />
        {!plan.offchain && chain ? (
          <div className="space-y-2">
            <p className="text-sm text-muted">
              The reward is escrowed by the CounterProof contract{" "}
              <Address value={chain.contract} label="contract address" /> on{" "}
              {network === "anvil-local" ? "local anvil (31337), not Monad" : config?.network_label}.
            </p>
            {chain.reachable === false ? (
              <Callout tone="warn" icon={<TriangleAlert />} title="Chain RPC unreachable">
                The backend cannot reach {chain.rpc ?? "the RPC"} right now{chain.error ? `: ${chain.error}` : ""}. Funding
                cannot be verified until it can.
              </Callout>
            ) : null}
            {chain.chain_id_matches === false ? (
              <Callout tone="warn" icon={<TriangleAlert />} title="Chain id mismatch">
                The RPC reports chain {chain.rpc_chain_id ?? "unknown"}, but the backend is configured for {chain.chain_id ?? "unknown"}.
              </Callout>
            ) : null}
            {chain.contract_has_code === false ? (
              <Callout tone="bad" icon={<TriangleAlert />} title="Contract not deployed">
                There is no code at the configured contract address on this chain, so funding would fail.
              </Callout>
            ) : null}
          </div>
        ) : null}
      </Block>

      <Block
        title="Publisher"
        description={
          plan.offchain
            ? "Recorded in the spec as the party making the promises."
            : "The connected wallet is bound in the spec as publisher and must send the funding transaction."
        }
      >
        {connectedAddress ? (
          <p className="flex flex-wrap items-center gap-2 text-sm text-fg">
            <span className="text-muted">Publisher (connected wallet):</span>
            <Address value={connectedAddress} label="publisher address" full />
          </p>
        ) : plan.offchain ? (
          <div className="space-y-3">
            <Input
              label="Publisher address"
              value={draft.manualPublisher}
              onChange={(e) => update({ manualPublisher: e.target.value })}
              mono
              required
              placeholder="0x..."
              autoComplete="off"
              spellCheck={false}
              error={draft.manualPublisher.trim() ? errors.publisher : undefined}
              hint="Off-chain challenges need no wallet. Or connect one to use its address."
            />
            <WalletButton className="justify-start" />
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-warn">{publisher.error}</p>
            <WalletButton className="items-start justify-start" />
          </div>
        )}
      </Block>

      {!plan.offchain ? (
        <Block title="Reward">
          <div className="max-w-sm">
            <Input
              label={rewardLabel}
              value={draft.rewardMon}
              onChange={(e) => update({ rewardMon: e.target.value })}
              inputMode="decimal"
              autoComplete="off"
              required
              error={errors.reward}
              hint={
                wei !== null && wei > BigInt(0) ? (
                  <span>
                    = <span className="font-mono">{wei.toString()}</span> wei, paid once to the first eligible settlement.
                  </span>
                ) : (
                  "Decimal amount, e.g. 0.01."
                )
              }
            />
          </div>
          <MonadReserveNotice network={network} />
        </Block>
      ) : (
        <Callout tone="neutral" icon={<FileText />} title="No reward">
          Off-chain challenges carry a reward of 0 and no settlement. The evaluator still replays candidates and records evidence bundles; no attestation is signed.
        </Callout>
      )}

      <Block
        title="Deadlines"
        description={
          plan.offchain
            ? "Recorded in the spec. Off-chain, no contract enforces them."
            : "Challengers must commit candidates on chain by the submission deadline. A verified violation must be settled by the settlement deadline; after it, you can refund the reward if nothing was settled."
        }
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div className="min-w-0 space-y-2">
            <Field label="Submission deadline (your local time)" htmlFor={deadlineId} required error={errors.submissionDeadline}>
              <DeadlineInput
                id={deadlineId}
                value={draft.submissionDeadline}
                onChange={(v) => update({ submissionDeadline: v })}
                invalid={!!errors.submissionDeadline}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Set the submission deadline from now">
              <span className="text-xs text-muted">From now:</span>
              {DEADLINE_PRESETS.map((p) => (
                <Button key={p.label} size="sm" variant="ghost" onClick={() => setDeadlineFromNow(p.seconds)}>
                  +{p.label}
                </Button>
              ))}
            </div>
            {draft.submissionDeadline !== null ? (
              <p className="text-xs text-muted">
                <span className="font-mono">{formatUnix(draft.submissionDeadline, { utc: true })}</span> (unix{" "}
                <span className="font-mono">{draft.submissionDeadline}</span>),{" "}
                <Countdown to={draft.submissionDeadline} prefix="closes in" />
              </p>
            ) : null}
          </div>

          <div className="min-w-0 space-y-2">
            <NumberField
              label="Settlement window after the submission deadline"
              value={draft.windowMinutes}
              onChange={(v) => update({ windowMinutes: v })}
              min={MIN_WINDOW_MIN}
              max={MAX_WINDOW_MIN}
              unit="minutes"
              required
              error={errors.window}
              hint="Between 5 minutes and 30 days (contract limits)."
            />
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Settlement window presets">
              {WINDOW_PRESETS.map((p) => (
                <Button
                  key={p.label}
                  size="sm"
                  variant="ghost"
                  className="aria-pressed:border-accent-line aria-pressed:bg-accent-soft aria-pressed:text-accent-text"
                  aria-pressed={draft.windowMinutes === p.minutes}
                  onClick={() => update({ windowMinutes: p.minutes })}
                >
                  {p.label}
                </Button>
              ))}
            </div>
            {settle !== null ? (
              <p className="text-xs text-muted">
                Settlement deadline <DateTime ts={settle} className="text-fg" /> (
                <span className="font-mono">{formatUnix(settle, { utc: true })}</span>), {formatWindow(draft.windowMinutes)} after
                the submission deadline.
              </p>
            ) : null}
          </div>
        </div>
      </Block>

      <Block
        title={plan.offchain ? "Rules that count as findings" : "Rules eligible for the reward"}
        description={
          plan.offchain
            ? "Recorded in the spec as eligible rules; off-chain nothing is paid."
            : "A verified violation of any checked rule can be settled for the reward. Unchecked rules are still checked and reported, but cannot be paid."
        }
      >
        {selected.length === 0 ? (
          <p className="text-sm text-warn">No rules selected. Go back to step 2.</p>
        ) : (
          <fieldset className="space-y-2" aria-describedby={errors.eligible ? "eligible-error" : undefined}>
            <legend className="sr-only">Eligible rules</legend>
            {selected.map((s) => (
              <Checkbox
                key={s.template.id}
                checked={s.rule.eligible}
                onChange={(e) => setRule(s.template.id, { ...s.rule, eligible: e.target.checked })}
                label={
                  <span>
                    <span className="font-mono text-xs text-muted">{s.id}</span> {s.statement ?? s.template.title}
                  </span>
                }
              />
            ))}
            {errors.eligible ? (
              <p id="eligible-error" role="alert" className="text-xs font-medium text-bad">
                {errors.eligible}
              </p>
            ) : null}
          </fieldset>
        )}
      </Block>
    </div>
  );
}

/**
 * datetime-local bound to unix seconds. Keeps its own text while the user edits a segment
 * (the browser reports "" until the value is complete) and follows outside changes.
 */
function DeadlineInput({
  id,
  value,
  onChange,
  invalid,
}: {
  id: string;
  value: number | null;
  onChange: (sec: number) => void;
  invalid: boolean;
}) {
  const [text, setText] = useState(() => toLocalInputValue(value));
  const [last, setLast] = useState(value);
  if (value !== last) {
    setLast(value);
    setText(toLocalInputValue(value));
  }
  return (
    <input
      id={id}
      type="datetime-local"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const v = fromLocalInputValue(e.target.value);
        if (v !== null) {
          setLast(v);
          onChange(v);
        }
      }}
      required
      aria-invalid={invalid ? true : undefined}
      aria-describedby={invalid ? `${id}-error` : undefined}
      className={cn(
        "block h-9 w-full min-w-0 rounded-md border border-control bg-inset px-3 text-sm text-fg tabular",
        "hover:border-control-strong focus-visible:border-accent aria-[invalid=true]:border-bad-line",
      )}
    />
  );
}
