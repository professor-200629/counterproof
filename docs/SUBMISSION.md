# Monad Metropolis submission draft

Requirements verified from hackathon.monad.xyz and monad.xyz/metropolis on 2026-10-06:
submissions close **2026-10-14 03:59 UTC**; required: project details + logo, GitHub
repository (public or shared with metropolis@hackathon.monad.xyz), a live product on Monad
Mainnet or Testnet, a technical demo video ≤ 3 min (working product, not slides), a pitch
video ≤ 2 min, one primary track, description and a go-to-market answer. Judging criteria
weights are only visible after sign-in and were **not** verified.

## Project

- **Name:** CounterProof
- **Tagline:** Put AI promises to the test.
- **Primary track:** 04 — Trust, Identity & AI Infrastructure
- **Repository:** https://github.com/professor-200629/counterproof (public)
- **Live product:** _(to add — contract on Monad Testnet + console; see STATUS.md)_

## Short description (≤ 280 characters)

Developers publish measurable promises about their AI agents and fund a reward on Monad.
Challengers earn it with reproducible counterexamples. CounterProof replays the evidence
in isolation, a deterministic checker decides, and the contract pays the bound challenger.

## Description

AI agents increasingly move money, but their promises — "never exceeds the budget",
"never pays twice" — are usually tested only by the team that wrote them. CounterProof
turns a promise into a funded, executable challenge.

A developer picks an agent version and approves exact rule parameters from explicit
templates (cumulative budget, merchant allowlist, single payment per order, no use after
revocation, no privileged calls from untrusted content). The full terms — target artifact
digest, environment, initial state, rules, checker version, scope, limits, evaluator,
deadlines and reward — are canonicalised and hashed, and that digest is funded in a Monad
escrow contract.

Challengers search for counterexamples. CounterProof ships three bounded strategies
(sequence exploration, adversarial merchant content, retry/replay) and an optional
model-assisted generator. A challenger commits a salted digest of its candidate on chain,
then reveals it. The evaluator replays the action sequence in a fresh isolated environment
against the committed initial state; the agent can only act through tool calls, and a
deterministic checker reads the evaluator's own hash-chained ledger — never the agent's
self-report. A separate signing service re-verifies the sealed evidence, replays it again,
checks the on-chain commitment and signs an EIP-712 attestation bound to the chain,
contract, challenge, spec, submission, candidate, evidence, challenger and recipient.
Anyone can relay it; the contract pays only the bound recipient.

Then the loop closes: the developer ships a fix, the same sequence is replayed against the
new version, and it is exported as a regression test.

What we are careful not to claim: a passing test is not proof of safety; the evaluator is a
declared trusted party, so its signature is an attestation, not a zero-knowledge proof; a
blockchain receipt proves the payment happened, not that the AI is correct. The demo's
primary failure comes from an intentionally vulnerable reference agent with planted
defects, and the interface labels it that way. We also evaluated a second implementation —
a live-model purchasing agent with no planted defects — and report what we actually found.

## Why Monad

Settlement is a tight loop of small transactions (fund, commit, settle, withdraw, refund)
that should feel instant next to an evidence console. Monad's ~0.3 s blocks and 2-block
finality make the receipt arrive while the evidence is still on screen. CounterProof uses
Foundry's native Monad support, tight gas limits (Monad bills the gas limit), and handles
the 10 MON reserve rule for value transfers.

## Go-to-market / user acquisition (honest)

We have no users yet. The first audience is teams about to ship purchasing or payments
agents who need evidence beyond their own unit tests, and researchers who already produce
failure cases and want them reproducible and paid. Plan: publish the open challenge format
and rule templates; run public challenges against open-source agents with small rewards;
offer the regression export as the free entry point (a counterexample becomes a test in
the team's CI); then charge for hosted evaluators and private challenges. Trust in the
evaluator is the main barrier; the roadmap moves from one declared evaluator to multiple
independent evaluators and published evaluator keys.

## Videos

- Technical demo (≤ 3 min): see docs/DEMO_SCRIPT.md.
- Pitch (≤ 2 min): see docs/PITCH.md.
