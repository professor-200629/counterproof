/**
 * ERC-8004 panel on the settlement page: what it says when the reporter posted feedback, when
 * the agent declares different code, and that nothing is shown off Monad testnet.
 */
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { Erc8004Body, Erc8004Panel } from "@/components/settlement/erc8004-panel";
import type { ChallengeView, Erc8004Record } from "@/lib/api";
import { qk } from "@/lib/queries";
import { fixture, render } from "./render";

const base = fixture<ChallengeView>("challenge_view");
const CONTRACT = "0xe37720f40bc214ce084595111b1ee4f4d454b5e4";
const view: ChallengeView = { ...base, network: "monad-testnet", chain_id: 10143, contract: CONTRACT, onchain_id: "1", status: "settled" };
const targetKey = `${view.spec.target.adapter}@${view.spec.target.version}`;

function record(artifact = view.spec.target.artifact_digest, withFeedback = true): Erc8004Record {
  return {
    available: true,
    chain_id: 10143,
    registries: { identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e", reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713" },
    agents: { [targetKey]: { agent_id: 2188, artifact_digest: artifact, owner: "0x27d338b0A15d73b7AE74d4bc70c134f67A0275Fa", tx: "0x" + "e2".repeat(32), explorer: "" } },
    feedback: withFeedback
      ? [
          {
            key: `${CONTRACT}:1`,
            challenge_onchain_id: 1,
            bounties: CONTRACT.toUpperCase().replace("0X", "0x"),
            agent_id: 2188,
            target: targetKey,
            reporter: "0xfbe501C35DeadC4F3E75Ba77f0FB0c43c9F1A47a",
            feedback_index: 1,
            tag1: "counterproof.verifiedViolation",
            tag2: "R1",
            value: 1,
            value_decimals: 0,
            evidence_digest: "sha256:" + "87".repeat(32),
            settle_tx: "0x" + "eb".repeat(32),
            feedback_hash: "0x" + "c4".repeat(32),
            feedback_file: {},
            tx: "0x" + "46".repeat(32),
            explorer: "",
          },
        ]
      : [],
  };
}

describe("ERC-8004 panel", () => {
  it("shows the posted feedback with its limits", () => {
    const { text, html } = render(createElement(Erc8004Body, { view, record: record() }));
    expect(text).toContain("Recorded as reputation feedback for agent #2188");
    expect(text).toContain("counterproof.verifiedViolation");
    expect(text).toContain("declares the artifact this challenge tested");
    expect(text).toContain("does not prove the agent unsafe in general");
    expect(html).toContain("https://testnet.monadscan.com/tx/0x" + "46".repeat(32));
  });

  it("flags an agent that declares different code", () => {
    const { text } = render(createElement(Erc8004Body, { view, record: record("sha256:" + "00".repeat(32), false) }));
    expect(text).toContain("feedback would be refused");
    expect(text).toContain("no ERC-8004 feedback has been posted");
    expect(text).not.toContain("Recorded as reputation feedback");
  });

  it("feedback about another contract is not attributed to this challenge", () => {
    const other = { ...view, contract: "0x" + "99".repeat(20) };
    const { text } = render(createElement(Erc8004Body, { view: other, record: record() }));
    expect(text).not.toContain("Recorded as reputation feedback");
  });

  it("renders nothing for a local chain", () => {
    const local = { ...view, network: "anvil-local" as const, chain_id: 31337 };
    const { text } = render(createElement(Erc8004Panel, { view: local }), { data: [[qk.erc8004, record()]] });
    expect(text.trim()).toBe("");
  });
});
