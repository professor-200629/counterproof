"use client";

import { BadgeCheck } from "lucide-react";
import { TxHash } from "@/components/tx-hash";
import { Address } from "@/components/ui/address";
import { Callout } from "@/components/ui/card";
import { Digest } from "@/components/ui/digest";
import { Section } from "@/components/ui/section";
import { KeyValueList } from "@/components/ui/stat";
import type { ChallengeView, Erc8004Record } from "@/lib/api";
import { MONAD_TESTNET_ID } from "@/lib/chain";
import { sameHex } from "@/lib/format";
import { useErc8004 } from "@/lib/queries";

const ADDRESS_URL = "https://testnet.monadscan.com/address/";

/**
 * ERC-8004 (Trustless Agents) for this challenge: the target's agent identity on the official
 * IdentityRegistry, and the reputation feedback the reporter posted after settlement. Monad
 * testnet only; nothing is shown for local chains.
 */
export function Erc8004Panel({ view }: { view: ChallengeView }) {
  const q = useErc8004({ enabled: view.network === "monad-testnet" });
  if (view.network !== "monad-testnet" || !q.data) return null;
  return <Erc8004Body view={view} record={q.data} />;
}

export function Erc8004Body({ view, record }: { view: ChallengeView; record: Erc8004Record }) {
  const targetKey = `${view.spec.target.adapter}@${view.spec.target.version}`;
  const agent = record.agents?.[targetKey];
  const agentMatches = agent && agent.artifact_digest === view.spec.target.artifact_digest;
  const feedback = (record.feedback ?? []).find(
    (f) => view.contract && sameHex(f.bounties, view.contract) && String(f.challenge_onchain_id) === String(view.onchain_id),
  );
  const regs = record.registries;

  return (
    <Section
      title="ERC-8004 agent reputation"
      description="The target's identity on the official ERC-8004 registries on Monad testnet, and what CounterProof's reporter recorded there about this challenge."
    >
      <div className="space-y-3 rounded-lg border border-line bg-surface p-4">
        {!record.available ? (
          <p className="text-sm text-muted">{record.reason ?? "No ERC-8004 record for this backend."}</p>
        ) : null}
        {feedback ? (
          <Callout tone="ok" icon={<BadgeCheck />} title={`Recorded as reputation feedback for agent #${feedback.agent_id}`} role="status">
            After the settlement was confirmed on chain, the reporter posted <code>{feedback.tag1}</code> for rule{" "}
            <code>{feedback.tag2}</code> to the official ReputationRegistry. The feedback file it points to names this challenge,
            its spec, the settled submission, the evidence digest and the settle transaction, so anyone can check it against the
            chain.
          </Callout>
        ) : record.available && view.status === "settled" ? (
          <p className="text-sm text-muted">Settled, but no ERC-8004 feedback has been posted for this challenge.</p>
        ) : null}

        {agent || feedback ? (
          <KeyValueList
            items={[
              ...(agent
                ? [
                    {
                      key: "agent",
                      label: "Agent identity",
                      value: (
                        <span>
                          agent #{agent.agent_id} on the IdentityRegistry, owned by the publisher{" "}
                          <Address value={agent.owner} label="agent owner" />
                        </span>
                      ),
                    },
                    {
                      key: "declares",
                      label: "Declared code",
                      value: (
                        <span className="inline-flex flex-wrap items-center gap-x-2">
                          <Digest value={agent.artifact_digest} label="declared artifact digest" />
                          <span className="text-xs text-muted">
                            {agentMatches
                              ? "the agent's own registration file declares the artifact this challenge tested"
                              : "differs from the artifact this challenge tested; feedback would be refused"}
                          </span>
                        </span>
                      ),
                    },
                    {
                      key: "registered",
                      label: "Registered in",
                      value: <TxHash hash={agent.tx} chainId={MONAD_TESTNET_ID} label="registration transaction hash" />,
                    },
                  ]
                : []),
              ...(feedback
                ? [
                    { key: "reporter", label: "Reviewer (client)", value: <Address value={feedback.reporter} label="reporter" /> },
                    {
                      key: "entry",
                      label: "Feedback",
                      value: `#${feedback.feedback_index} from this reviewer: value ${feedback.value} (decimals ${feedback.value_decimals}), tag1 ${feedback.tag1}, tag2 ${feedback.tag2}`,
                    },
                    { key: "hash", label: "Feedback file hash", value: <Digest value={feedback.feedback_hash} label="feedback hash (keccak256)" /> },
                    { key: "tx", label: "Posted in", value: <TxHash hash={feedback.tx} chainId={MONAD_TESTNET_ID} label="feedback transaction hash" /> },
                  ]
                : []),
              ...(regs
                ? [
                    {
                      key: "regs",
                      label: "Registries",
                      value: (
                        <span className="inline-flex flex-wrap gap-x-3">
                          <Address value={regs.identity} label="IdentityRegistry" href={`${ADDRESS_URL}${regs.identity}`} note="IdentityRegistry" />
                          <Address value={regs.reputation} label="ReputationRegistry" href={`${ADDRESS_URL}${regs.reputation}`} note="ReputationRegistry" />
                        </span>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        ) : null}
        <p className="text-xs text-muted">
          ERC-8004 feedback is a statement by the reviewer address; readers decide which reviewers they trust. It records one verified
          violation of one rule by one code version. It does not prove the agent unsafe in general, and its absence does not prove it
          safe.
        </p>
      </div>
    </Section>
  );
}
