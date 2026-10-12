/**
 * Every route's view in its loading, error, not-found, empty and data states, rendered from
 * real backend responses (src/test/fixtures). Checks the truth labels and the links between
 * pages; nothing here talks to a backend or a chain.
 */
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChallengeDetail } from "@/components/challenge/challenge-detail";
import { RunCard } from "@/components/challenge/run-card";
import { CompareView } from "@/components/compare/compare-view";
import { CreateChallenge } from "@/components/create/create-challenge";
import { EvidenceViewer } from "@/components/evidence/evidence-viewer";
import { ChallengesListView } from "@/components/overview/challenges-list-view";
import { OverviewView } from "@/components/overview/overview-view";
import { SettlementView } from "@/components/settlement/settlement-view";
import { AGENT_CLAIM_LABEL, NOT_PROOF_OF_SAFETY, SEARCH_SELF_CHECK_NOTE } from "@/components/truth";
import { ApiError, type AppConfig, type ChallengeListItem, type ChallengeView, type Evaluation, type Overview, type Settlement } from "@/lib/api";
import { qk } from "@/lib/queries";
import { fixture, hrefs, render } from "./render";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  notFound: () => {
    throw new Error("notFound");
  },
}));

const config = fixture<AppConfig>("config");
const overview = fixture<Overview>("overview");
const list = fixture<ChallengeListItem[]>("challenges_list");
const view = fixture<ChallengeView>("challenge_view");
const evaluation = fixture<Evaluation>("evaluation_done");
const queuedEvaluation = fixture<Evaluation>("evaluation_queued");
const bundle = fixture("evidence_bundle");
const targets = fixture("targets");
const templates = fixture("rule-templates");
const strategies = fixture("strategies");
const regression = fixture<{ id: string }>("regression_done");
const candidate = fixture("candidate");

const notFound = (path: string) => new ApiError({ status: 404, detail: "not found", path });
const serverError = (path: string) => new ApiError({ status: 500, detail: "database is locked", path });
const unreachable = (path: string) => new ApiError({ status: 0, detail: "Backend unreachable at /api", path });

/** "trustless" may only appear negated ("not trustless"). */
const CLAIMS_TRUSTLESS = /(?<!not )trustless/i;

describe("overview /", () => {
  it("shows real counts, the fixture badge and challenge links", () => {
    const { html, text } = render(createElement(OverviewView), {
      data: [
        [qk.overview, overview],
        [qk.challenges, list],
        [qk.config, config],
      ],
    });
    expect(text).toContain("Intentionally vulnerable fixture - planted defects");
    expect(text).not.toMatch(CLAIMS_TRUSTLESS);
    expect(hrefs(html)).toContain("/challenges/1");
    expect(hrefs(html)).toContain("/challenges/new");
  });

  it("without a live-model finding, features the newest verified violation and keeps its fixture label prominent", () => {
    const ev = view.evaluations[0];
    const { html, text } = render(createElement(OverviewView), {
      data: [
        [qk.overview, overview],
        [qk.challenges, list],
        [qk.config, config],
        [qk.challenge("1"), view],
        [qk.evidence(ev.evidence_digest as string), bundle],
        [qk.challengeRegressions("1"), [regression]],
      ],
    });
    expect(text).toContain("Featured finding (no live-model finding recorded)");
    expect(text).toContain("An intentionally vulnerable fixture violated R1");
    expect(text.indexOf("Featured finding")).toBeLessThan(text.indexOf("Awaiting settlement"));
    expect(html).toMatch(/Intentionally vulnerable fixture - planted defects/);
    expect(text).toContain("No reward: an off-chain challenge produces evidence only.");
    // A same-family repair is recorded for this fixture: it is shown, with a link to the comparison.
    expect(text).toContain("Replayed on ref-purchasing-agent@1.1.0");
    expect(hrefs(html).some((h) => h.startsWith("/challenges/1/compare?") && h.includes(`regression=${regression.id}`))).toBe(true);
    expect(hrefs(html)).toContain(`/evaluations/${ev.id}`);
    // Counts: awaiting settlement vs ever funded, and the composition of verified violations.
    expect(text).toContain("Awaiting settlement");
    expect(text).toContain("Ever funded");
    expect(text).toContain("0 on a live-model agent, 1 on a planted-defect fixture");
    expect(text).toContain("No rewards: this backend runs off-chain and escrows nothing.");
    expect(text).not.toMatch(CLAIMS_TRUSTLESS);
  });

  it("loading, unreachable and empty", () => {
    expect(render(createElement(OverviewView)).text).toContain("Loading overview counts");
    expect(render(createElement(OverviewView), { errors: [[qk.overview, unreachable("/overview")]] }).text).toContain("Backend unreachable");
    const empty = render(createElement(OverviewView), {
      data: [
        [qk.overview, { ...overview, challenges: 0, activity: [] }],
        [qk.challenges, []],
        [qk.config, config],
      ],
    });
    expect(empty.text).toContain("No challenges yet");
    expect(empty.text).toContain("Create the first challenge");
    // The intro follows the configured network (this fixture backend is off-chain): no "Monad" claim.
    expect(empty.text).toContain("this backend runs off-chain");
    expect(empty.text).not.toMatch(/escrowed on Monad/);
  });
});

describe("challenges /challenges", () => {
  it("lists challenges with verified counts", () => {
    const { html, text } = render(createElement(ChallengesListView), { data: [[qk.challenges, list]] });
    expect(text).toContain("1 verified violation");
    expect(hrefs(html)).toContain("/challenges/1");
  });

  it("loading, error and empty", () => {
    expect(render(createElement(ChallengesListView)).text).toContain("Loading challenges");
    expect(render(createElement(ChallengesListView), { errors: [[qk.challenges, serverError("/challenges")]] }).text).toContain(
      "database is locked",
    );
    expect(render(createElement(ChallengesListView), { data: [[qk.challenges, []]] }).text).toContain("No challenges yet");
  });
});

describe("create /challenges/new", () => {
  it("loading, error and the first step", () => {
    expect(render(createElement(CreateChallenge)).text).toContain("Loading targets, rule templates and backend configuration");
    const failed = render(createElement(CreateChallenge), {
      data: [
        [qk.config, config],
        [qk.ruleTemplates, templates],
      ],
      errors: [[qk.targets, serverError("/targets")]],
    }).text;
    expect(failed).toContain("Cannot load what a challenge is built from");
    expect(failed).toContain("database is locked");
    const { text } = render(createElement(CreateChallenge), {
      data: [
        [qk.config, config],
        [qk.targets, targets],
        [qk.ruleTemplates, templates],
      ],
    });
    expect(text).toContain("Step 1 of 5");
    expect(text).toContain("Intentionally vulnerable fixture - planted defects");
  });
});

describe("challenge /challenges/[id]", () => {
  const el = createElement(ChallengeDetail, { id: "1" });

  it("shows the promise, provenance and links to settlement, compare and evidence", () => {
    const { html, text } = render(el, {
      data: [
        [qk.challenge("1"), view],
        [qk.config, config],
        [qk.ruleTemplates, templates],
        [qk.strategies, strategies],
      ],
    });
    expect(text).toContain(view.spec.title);
    expect(text).toContain("Intentionally vulnerable fixture - planted defects");
    expect(text).toContain("Off-chain - evidence only");
    const links = hrefs(html);
    expect(links).toContain("/challenges");
    expect(links).toContain("/challenges/1/settlement");
    expect(links).toContain("/challenges/1/compare");
    expect(links).toContain(`/evaluations/${view.evaluations[0].id}`);
  });

  it("loading, not found and error", () => {
    expect(render(el).text).toContain("Loading challenge");
    expect(render(el, { errors: [[qk.challenge("1"), notFound("/challenges/1")]] }).text).toContain("Challenge #1 does not exist");
    const failed = render(el, { errors: [[qk.challenge("1"), serverError("/challenges/1")]] }).text;
    expect(failed).toContain("Could not load the challenge");
    expect(failed).toContain("database is locked");
  });
});

describe("evidence /evaluations/[id]", () => {
  const el = createElement(EvidenceViewer, { id: evaluation.id });

  it("answers the five questions from the evidence bundle", () => {
    const { html, text } = render(el, {
      data: [
        [qk.evaluation(evaluation.id), evaluation],
        [qk.challenge(String(evaluation.challenge_id)), view],
        [qk.evidence(evaluation.evidence_digest as string), bundle],
        [qk.config, config],
        [qk.ruleTemplates, templates],
      ],
    });
    for (const q of ["What was promised?", "What failed?", "Can I reproduce it?", "Who checked it?", "Was the reward paid?"]) {
      expect(text).toContain(q);
    }
    expect(text).toContain("declared trusted evaluator");
    expect(text).toContain("off-chain challenge: there is no reward");
    expect(text).not.toMatch(CLAIMS_TRUSTLESS);
    const links = hrefs(html);
    expect(links).toContain("/challenges/1");
    expect(links).toContain("/challenges/1/settlement");
    expect(links.some((h) => h.startsWith("/challenges/1/compare?candidate="))).toBe(true);
  });

  it("labels agent self-reports as non-evidence", () => {
    const { text } = render(el, {
      data: [
        [qk.evaluation(evaluation.id), evaluation],
        [qk.challenge("1"), view],
        [qk.evidence(evaluation.evidence_digest as string), bundle],
      ],
    });
    expect(text).toContain(AGENT_CLAIM_LABEL);
  });

  it("loading, not found, queued replay", () => {
    expect(render(el).text).toContain("Loading evaluation");
    expect(render(el, { errors: [[qk.evaluation(evaluation.id), notFound(`/evaluations/${evaluation.id}`)]] }).text).toContain(
      "does not exist",
    );
    const queued = render(el, {
      data: [
        [qk.evaluation(evaluation.id), queuedEvaluation],
        [qk.candidate(queuedEvaluation.candidate_id as string), candidate],
      ],
    }).text;
    expect(queued).toContain("Independent replay queued");
    expect(queued).toContain("reports no partial progress");
  });
});

describe("settlement /challenges/[id]/settlement", () => {
  it("off-chain: evidence only, no reward", () => {
    const { html, text } = render(createElement(SettlementView, { challengeId: "1" }), {
      data: [
        [qk.challenge("1"), view],
        [qk.config, config],
      ],
    });
    expect(text).toContain("Off-chain challenge - there is no reward to settle");
    expect(hrefs(html)).toContain(`/evaluations/${view.evaluations[0].id}`);
    expect(hrefs(html)).toContain("/challenges/1");
  });

  it("awaiting funding on local anvil: fund in place, never called Monad", () => {
    const anvilConfig: AppConfig = {
      ...config,
      network: "anvil-local",
      network_label: "Local anvil chain (31337) - not Monad testnet",
      chain: {
        ...config.chain,
        network: "anvil-local",
        chain_id: 31337,
        contract: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
        rpc: "http://127.0.0.1:8545",
        reachable: true,
        explorer_tx_url: null,
      },
    };
    const anvilView: ChallengeView = {
      ...view,
      status: "awaiting_funding",
      network: "anvil-local",
      chain_id: 31337,
      contract: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      reward_wei: "1000000000000000000",
      spec: {
        ...view.spec,
        settlement: { chain_id: 31337, network: "anvil-local", contract: "0x5FbDB2315678afecb367f032d93F642f64180aa3" },
        reward: { ...view.spec.reward, amount_wei: "1000000000000000000" },
      },
    };
    const settlement: Settlement = { challenge: anvilView, attestation: null, onchain: null, explorer_template: null };
    const { text } = render(createElement(SettlementView, { challengeId: "1" }), {
      data: [
        [qk.challenge("1"), anvilView],
        [qk.settlement("1"), settlement],
        [qk.config, anvilConfig],
      ],
    });
    expect(text).toContain("Not paid: the reward is not escrowed yet");
    expect(text).toContain("Fund challenge #1");
    expect(text).toContain("local anvil (31337)");
    expect(text).not.toMatch(/monadscan/i);
    expect(text).toContain("A settlement receipt proves");
  });

  it("loading and not found", () => {
    const el = createElement(SettlementView, { challengeId: "7" });
    expect(render(el).text).toContain("Loading challenge");
    expect(render(el, { errors: [[qk.challenge("7"), notFound("/challenges/7")]] }).text).toContain("Challenge #7 does not exist");
  });
});

describe("compare /challenges/[id]/compare", () => {
  const el = createElement(CompareView, { challengeId: "1", initial: {} });

  it("starts from the verified counterexample and lists previous regressions", () => {
    const { html, text } = render(el, {
      data: [
        [qk.challenge("1"), view],
        [qk.targets, targets],
        [qk.challengeRegressions("1"), [regression]],
        [qk.regression(regression.id), regression],
        [qk.evidence(evaluation.evidence_digest as string), bundle],
      ],
    });
    expect(text).toContain("Replay a verified counterexample");
    expect(text).toContain(regression.id);
    expect(hrefs(html)).toContain(`/evaluations/${view.evaluations[0].id}`);
    // Same agent family (ref-purchasing-agent 1.0.0 -> 1.1.0), deterministic: the repaired version.
    expect(text).toContain("The repaired version resisted this sequence");
    expect(text).not.toContain("different agent family");
    // The picker offers versions of the same adapter only.
    expect(html).toContain('value="ref-purchasing-agent@1.1.0"');
    expect(html).not.toMatch(/value="llm-purchasing-agent@/);
  });

  it("never takes a re-run of the original version as the repaired version", () => {
    // Same adapter AND same version as the challenge's target: a re-run, not a repair.
    const originalKey = `${view.spec.target.adapter}@${view.spec.target.version}`;
    const rerun = { ...(regression as Record<string, unknown>), id: "reg_rerun_original", target_key: originalKey };
    const primed = {
      data: [
        [qk.challenge("1"), view],
        [qk.targets, targets],
        [qk.challengeRegressions("1"), [rerun]],
        [qk.regression("reg_rerun_original"), rerun],
        [qk.evidence(evaluation.evidence_digest as string), bundle],
      ] as [readonly unknown[], unknown][],
    };
    // By default the After column stays empty: no repaired version has been replayed.
    const byDefault = render(el, primed).text;
    expect(byDefault).toContain("Repaired version: none replayed");
    expect(byDefault).toContain("No repaired version of this agent has been replayed yet");
    expect(byDefault).toContain("same version re-run, not a repair");
    expect(byDefault).not.toContain("resisted this sequence");
    // Picked explicitly, it is labelled as the original version re-run.
    const picked = render(createElement(CompareView, { challengeId: "1", initial: { regression: "reg_rerun_original" } }), primed).text;
    expect(picked).toContain("Same version re-run, not a repair");
    expect(picked).toContain(`${originalKey} is the original version re-run, not a repair`);
    expect(picked).not.toContain("The repaired version resisted");
    expect(picked).not.toMatch(/Regression on ref-purchasing-agent@1\.0\.0/);
  });

  it("loading and not found", () => {
    expect(render(el).text).toContain("Loading challenge");
    expect(render(el, { errors: [[qk.challenge("1"), notFound("/challenges/1")]] }).text).toContain("Challenge #1 does not exist");
  });
});

describe("run card: no violation found", () => {
  it("says whose check it was, what was tested, how the sequences ended and what it does not show", () => {
    const run = view.runs.find((r) => r.status === "no_violation_found");
    if (!run?.record) throw new Error("fixture has no finished no_violation_found run");
    const { text } = render(createElement(RunCard, { run, view }));
    expect(text).toContain(SEARCH_SELF_CHECK_NOTE);
    expect(text).toContain(NOT_PROOF_OF_SAFETY.toLowerCase());
    const completed = run.record.run_outcomes.completed;
    expect(text).toContain(`none of the ${completed} that ran to completion violated a rule`);
    expect(text).toContain(`${view.spec.target.adapter}@${view.spec.target.version}`);
    expect(text).toContain("Nothing here was replayed by the declared evaluator");
    expect(text).toContain(`${view.spec.environment.isolation} isolation`);
    expect(text).toContain(view.spec.initial_state.world_id);
    expect(text).toContain("Why it stopped");
    expect(text).toContain("Search budget");
    expect(text).toContain(`Search generator: ${run.mode}`);
  });

  it("separates the search generator's mode from a live-model target", () => {
    const run = view.runs[0];
    const liveView: ChallengeView = {
      ...view,
      spec: { ...view.spec, target: { ...view.spec.target, determinism: "stochastic", config: { model: "openai/gpt-oss-120b" } } },
    };
    const { text } = render(createElement(RunCard, { run, view: liveView }));
    expect(text).toContain("Search generator is not the target");
    expect(text).toContain("openai/gpt-oss-120b");
    expect(text).toContain("its replies are stochastic");
  });
});
