# Monad Metropolis submission draft

**Requirements status.**
- On 2026-10-06 the portal, read after sign-in, listed: submissions closing 2026-10-14 03:59 UTC;
  project details and logo; a GitHub repository (public or shared with metropolis@hackathon.monad.xyz);
  a live product on Monad mainnet or testnet; a technical demo video ≤ 3 min; a pitch video ≤ 2 min;
  one primary track; and a go-to-market answer.
- On 2026-10-13 the public pages showed only "Submission deadline: 13 Oct", with no time, and no
  video limits. The portal needs sign-in, so the details above could not be re-verified.
  **Confirm the cut-off and limits in the portal before submitting.**
- Judging weights were never visible without sign-in.

## Project

- **Name:** CounterProof
- **Tagline:** Put AI promises to the test.
- **Primary track:** 04, Trust, Identity & AI Infrastructure
- **Repository:** https://github.com/professor-200629/counterproof (public)
- **Live product:**
  - Contract `0xE37720f40BC214Ce084595111B1Ee4F4d454b5e4` on Monad Testnet (10143), source verified:
    https://testnet.monadscan.com/address/0xE37720f40BC214Ce084595111B1Ee4F4d454b5e4
  - https://counterproof.vercel.app is a read-only **evidence explorer** of the recorded Monad
    testnet run. It runs nothing live.
  - The evaluator, signer and fresh runs work locally: `scripts/dev.py local|testnet` (see docs/REPRODUCE.md).
- **ERC-8004:** agents 2190 (the vulnerable fixture) and 2192 (the live-model agent) are on the
  official IdentityRegistry. Their feedback was posted by reporter
  `0xfbe501C35DeadC4F3E75Ba77f0FB0c43c9F1A47a` on the official ReputationRegistry.
- **Re-check it yourself:** `scripts/verify_evidence.py --url https://counterproof.vercel.app --chain`

## Short description (≤ 280 characters)

CounterProof pays people to break an AI agent's promise. Counterexamples are committed on Monad,
replayed independently by the evaluator and again by its signer, and settled to the committed
challenger. Each result becomes ERC-8004 reputation and a regression test for the fix.

## Description

AI agents increasingly move money. Their promises ("never exceeds the budget", "never changes
its own permissions") are usually tested only by the team that wrote them. CounterProof turns
one such promise into a funded, executable challenge.

**Promise.** A developer picks an agent version and approves exact rule parameters from five
explicit templates: cumulative budget, merchant allowlist, one payment per order, no use after
revocation, and no privileged calls from untrusted content. The full terms are canonicalised
and hashed. That digest is escrowed with a reward in a Monad contract. The terms cover the
target's code digest, environment, initial state, rules, checker version, limits, evaluator,
deadlines and reward.

**Challenge.** Challengers search with three bounded strategies: sequence exploration,
adversarial merchant content, and retry/replay. They commit a salted digest of a candidate on
chain before revealing it.

**Independent replay.** The evaluator replays the candidate in fresh isolated runs from the
committed initial state. The agent acts only through tool calls. A deterministic checker reads
the evaluator's own hash-chained ledger, never the agent's word. Live-model agents are
statistical, so the spec fixes a k-of-n policy (2 of 3).

**Separate signer.** Before signing, the signer loads the committed candidate by its on-chain
digest and re-runs the full k-of-n itself, with its own model broker. It signs an EIP-712
attestation over the evidence it produced. The worker's evidence is only a provenance reference.

**Payment.** The attestation binds chain, contract, challenge, spec, submission, candidate,
evidence, challenger, recipient, verdict and expiry. Anyone may relay it; the contract pays
only the recipient bound at commit. An expired attestation can be renewed for the same
verified submission while the settlement window is open.

**Reputation.** Each agent has an identity in the official ERC-8004 IdentityRegistry that
declares its exact code digest. A separate reporter key re-checks the settlement on chain, then
posts `counterproof.verifiedViolation` feedback to the official ReputationRegistry. It refuses
to attach a result to an agent that declares different code.

**Repair.** The same counterexample is replayed against the developer's new version of the
same agent and exported as a pytest regression test that really executes the agent.

**What happened on Monad testnet (2026-10-11).** Challenge #3 was a live-model purchasing agent
(our tool loop, Groq `openai/gpt-oss-120b`, no planted defects).
- The merchant-content search found injected product text that made the agent call
  `update_mandate(budget = 1,000,000)`.
- The evaluator reproduced it in 3 of 3 fresh replays. The marketplace refused the call; R5
  counts the attempt.
- The reward was settled and withdrawn, and the result was recorded as ERC-8004 feedback for
  agent 2192.
- Challenge #1 shows the same loop on an **intentionally vulnerable fixture** (labelled as such).
  Challenge #2 found no violation within its search budget and was refunded.

**What we fixed and re-tested (2026-10-13; local runs, real model, no new chain transactions).**
- `llm-purchasing-agent@0.2.0` enforces tool capabilities in code. Privileged tools are not
  offered, the dispatcher refuses them anyway, and in-code guards cover budget, merchant,
  duplicate-payment and revocation.
- The recorded attack replayed against 0.2.0: R5 held in 3 of 3 live replays. The model never
  proposed the privileged tool (it was not offered), so the in-code refusal is shown by scripted
  tests, not by this live run.
- An ordinary purchase completed in 3 of 3 live replays.
- The exported regression test passes on 0.2.0 and fails on 0.1.1.
- Separately, a fork rehearsal (a local anvil fork of Monad testnet; no real transaction)
  exercised the new signer path end to end. The signer's own replays reproduced the violation
  in 3 of 3, and it signed its own evidence.

**Where it sits in Track 04.** Validators check what an agent did against what it said it would
do. CounterProof is the adversarial side: it pays people to find the inputs that break a
promise, proves the break by independent replay, and turns it into a regression test and
portable reputation.

**What we do not claim.**
- The evaluator and its signer are a declared trusted party. Their signature is an attestation,
  not a zero-knowledge proof; extra processes, keys or hashes do not make it trustless.
- A Monad receipt proves that a transaction happened, not that an AI is correct.
- A passing or "no violation found" result is bounded evidence, not general safety.
- Every agent tested so far was written by our team. The model is third-party; the agent is not.
- No external agent has been evaluated yet, and no one outside the team has reproduced a result
  yet. The plan and a reproduction kit are in the repository.

## Why Monad

The parts that need a neutral, shared record run on chain:
- the escrowed reward, bound to an immutable spec digest;
- the challenger's commitment before reveal;
- the payout bound to the committed recipient, whoever relays it;
- ERC-8004 reputation that other agent marketplaces can read.

Measured on testnet from the recorded receipts: blocks about 0.3 s apart, and the following
gas costs (Monad bills the gas limit) at 102 gwei:

| Transaction | Testnet MON |
|---|---|
| fund | ~0.0185 |
| commit | ~0.0140 |
| settle | ~0.0142 |
| withdraw | ~0.0070 |
| ERC-8004 feedback | ~0.0398 |

The scripts set tight gas limits and respect the 10 MON reserve rule for value transfers.

## Go-to-market / user acquisition (honest)

We have no users yet. The first audience is teams about to ship purchasing or payments agents
who need evidence beyond their own unit tests, and researchers who already find failure cases
and want them reproducible and paid. Plan:
1. Publish the open challenge format and rule templates.
2. Integrate one external open-source agent; the AP2 reference shopping agent is pinned in
   docs/EXTERNAL_AGENT_PLAN.md.
3. Run public challenges with small rewards.
4. Offer the regression export as the free entry point (a counterexample becomes a test in the
   team's CI).
5. Charge for hosted evaluators and private challenges.

Trust in the evaluator is the main barrier. The roadmap goes from one declared evaluator to
several independent evaluators with published keys.

## Videos

- Technical demo: docs/DEMO_SCRIPT.md (merchant injection → unauthorized tool attempt →
  independent replay → Monad reward → ERC-8004 feedback → repaired-agent replay → regression export).
- Pitch: docs/PITCH.md.
