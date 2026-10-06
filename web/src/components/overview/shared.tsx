/**
 * Small pieces shared by the Overview and Challenges pages. Kept in this folder so the
 * shared UI kit (src/components/ui) stays untouched.
 */
import type { ReactNode } from "react";
import type { ChallengeListItem } from "@/lib/api";
import { cn } from "@/lib/cn";
import { toneFill, toneText, type Tone } from "@/components/ui/tone";

/** Where this backend escrows rewards, from its configured network (never "Monad" unless it is). */
function rewardPhrase(network: string | null | undefined): string {
  switch (network) {
    case "monad-testnet":
      return "optionally backed by a reward escrowed on Monad Testnet (10143)";
    case "anvil-local":
      return "optionally backed by a reward escrowed on a local anvil dev chain (31337, not Monad)";
    case "offchain":
      return "with evidence only (this backend runs off-chain, so no reward is escrowed)";
    default:
      return "optionally backed by a reward escrowed on chain";
  }
}

/** What CounterProof does, in two sentences (empty states), for the backend's configured network. */
export function productIntro(network: string | null | undefined): string {
  return (
    `CounterProof lets a developer publish measurable promises about an AI purchasing agent, ${rewardPhrase(network)}. ` +
    "Challengers search for action sequences that break a promise; a declared trusted evaluator replays each candidate in a fresh synthetic marketplace, a deterministic checker decides, and only a verified violation can be settled to the challenger."
  );
}

/** The loop a challenge goes through, in order (empty states). */
export const CHALLENGE_LOOP: { title: string; text: string }[] = [
  { title: "Promise", text: "Pick a target agent version and rule templates; the spec is content-addressed by its digest." },
  { title: "Search", text: "Challenger strategies try action sequences within a stated budget." },
  { title: "Replay", text: "The evaluator replays each submitted candidate in a fresh, isolated synthetic marketplace." },
  { title: "Settle", text: "On chain, a signed attestation lets anyone relay settlement to the recipient bound at commit time." },
  { title: "Regress", text: "The same sequence is replayed against the repaired version and exported as a test." },
];

/** Newest first (by creation time, then id). */
export function sortNewest(items: ChallengeListItem[]): ChallengeListItem[] {
  return [...items].sort((a, b) => b.created_at - a.created_at || b.id - a.id);
}

/** The challenge loop as a numbered row of steps (empty states of Overview and Challenges). */
export function ChallengeLoop({ className }: { className?: string }) {
  return (
    <ol className={cn("grid gap-4 sm:grid-cols-2 lg:grid-cols-5", className)} aria-label="How a challenge proceeds">
      {CHALLENGE_LOOP.map((step, i) => (
        <li key={step.title} className="min-w-0">
          <p className="text-xs font-semibold text-fg">
            <span className="tabular text-subtle">{i + 1}.</span> {step.title}
          </p>
          <p className="mt-1 text-xs text-muted">{step.text}</p>
        </li>
      ))}
    </ol>
  );
}

/** A dot plus a short text state ("Reachable", "Unavailable"). The text carries the meaning. */
export function Indicator({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm", toneText[tone], className)}>
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", toneFill[tone])} />
      <span className="min-w-0">{children}</span>
    </span>
  );
}

/** Stacked label / value pairs that stay readable in narrow columns. */
export function Facts({ items, className }: { items: { key: string; label: ReactNode; value: ReactNode }[]; className?: string }) {
  return (
    <dl className={cn("space-y-3", className)}>
      {items.map((it) => (
        <div key={it.key} className="min-w-0">
          <dt className="text-xs font-medium text-muted">{it.label}</dt>
          <dd className="mt-1 min-w-0 break-words text-sm text-fg">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
