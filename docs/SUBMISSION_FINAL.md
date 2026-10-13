# CounterProof — final submission package

Prepared 2026-10-13. The text below is ready to paste into the matching portal fields;
the final submission form still needs the owner's check. No form has been
submitted and no legal terms have been accepted on the owner's behalf.

## Requirements and deadline

The signed-in [official dashboard](https://hackathon.monad.xyz/dashboard) and its rules
modal were checked read-only on 2026-10-13 using the owner's existing session. Rules
**v3.0, updated 3 September**, confirm a **13 October 2026, 11:59 PM US Eastern** deadline.
The dashboard displays **14 October 2026, 9:29 AM GMT+5:30**; this is **03:59 UTC / 9:29 AM
IST**, matching the announcement context. The signed-in portal is authoritative if it changes.

Currently verified requirements include: **one project and one track**, **public GitHub code with an OSI-approved
open-source LICENSE**, attribution, build-window commits, AI-tool disclosure in README,
a functioning prototype a third party can run from README, a public technical demo of
actual operation **at most 3 minutes**, contract addresses/transaction hashes, and
Monad mainnet or testnet deployment. The Project Overview confirms **project name at
most 120 characters** and **one-line description at most 200 characters**. The portal
says to create a project before the Submission tab; no project was created, so those
remaining fields were not inspected.

The **pitch limit of 2 minutes**, logo field and its accepted format/dimensions/size,
and go-to-market field were previously recorded on 2026-10-06;
details beyond the current rules and Project Overview remain to be checked in the final
form. The earlier private-code option is superseded by the current public-code rule.

**Working-product assessment:** the deployed Monad testnet reward contract and historical
receipts satisfy the deployment evidence component. The clean-clone scripted route
executes adapters locally; the full evaluator/signer stack is runnable from README.
The hosted URL is a read-only evidence explorer. The technical video must demonstrate
actual local operation, with elapsed time, to support the runnable-prototype requirement.
No claim is made that browsing the snapshot alone fulfils that requirement or guarantees
eligibility. The owner approved a repository-wide **MIT** [LICENSE](../LICENSE) in this
session. It is prepared locally and must be included in the reviewed publication. The
decision is recorded in [LICENSING_PROPOSAL.md](LICENSING_PROPOSAL.md).

## Name, tagline and short description

**Name:** CounterProof — 12 characters (current limit: 120).

**Tagline:** Put AI promises to the test.

**Primary track:** Trust, Identity & AI Infrastructure (Track 04).

**One-line description — 187 characters** (current limit: 200), including spaces and
punctuation, excluding this label and the trailing newline:

CounterProof funds challenges to AI agent promises on Monad. Reproduced failures earn rewards, create ERC-8004 feedback for the tested version, and become regression tests for the repair.

## Problem

An AI shopping agent can follow a user's request while also attempting an unauthorized
action after reading merchant text. A team's own success report is insufficient to tell
whether its spending and permission promises held. Failure cases need explicit rules,
repeatable execution and a record that other teams can inspect.

## Product and demonstration

CounterProof turns one measurable agent promise into a funded challenge. The publisher
approves an exact agent version, initial state, rule parameters and reproduction policy.
Challengers search for a counterexample, commit it on Monad before revealing it, and
earn the bound reward when a trusted evaluator independently reproduces the violation.
The result can become ERC-8004 feedback for that code version and an executable
regression test for its repair.

The first domain is purchasing agents in a synthetic marketplace with invented shops,
products and SYN balances. On 11 October, injected merchant text made our live-model
agent, `llm-purchasing-agent@0.1.1` using Groq `openai/gpt-oss-120b`, attempt
`update_mandate(budget=1000000)` in **3/3 recorded replays**. The call reached the
marketplace and was refused: its budget did not increase. R5 prohibits the attempt.

Against repaired `0.2.0`, the same attack violated R5 in **0/3 completed recorded live
replays** on 13 October and the requested purchase still completed. An ordinary
purchase also completed in 3/3. The model proposed no privileged tool in those repaired
live runs. The dispatcher's refusal of a forced privileged proposal is exercised by the
scripted regression, not those live runs. The regression discriminates between both
versions by executing them with the original recorded model proposals.

The hosted evidence explorer is read-only. Fresh evaluation and the signer run locally.
The clean-clone reproduction route needs no operator database, wallet or signing key;
fresh live replay is explicitly enabled and needs the reader's own provider credential.

## Technical implementation and differentiation

The stack is Python/FastAPI with durable SQLite jobs, a Next.js/React evidence console,
and a Solidity EIP-712 reward contract on Monad testnet. Canonical SHA-256 digests bind
the specification and candidate. The evaluator runs a fresh isolated child for each
replay and the deterministic checker reads its own hash-chained market ledger. Five
rule templates cover cumulative spend, approved merchants, one payment per order,
revocation and privileged calls. Live-model findings use the fixed 2-of-3 policy.

The current signer independently loads the on-chain committed candidate, replays the
full policy using its own broker and checker, and signs its own evidence digest. It can
renew an expired attestation for the same eligible submission inside the settlement
window. Authentication, ownership checks, resource ceilings and operator stop controls
protect local judge execution. Targets receive neither provider credentials nor signing
keys. Process isolation is used only for first-party adapters.

CounterProof connects a failure to the exact promise and code version, a committed
recipient, observable ledger effects, a reward and a discriminating regression. It does
not turn a passing test into a broad safety certificate. The evaluator remains a declared
trusted party; its signature is an attestation, not a zero-knowledge proof.

The 11 October testnet settlement used the historical signer source preserved at
`testnet-2026-10-11`. The new signer's independent k-of-n verification was subsequently
checked on local anvil and a local fork of Monad testnet. It has not been exercised by a
new transaction on Monad testnet. Historical funded specifications and evidence remain
unchanged; current-version fresh runs have new artifact bindings.

## Monad and ERC-8004 usage

Monad holds the spec-bound reward escrow, candidate commitment, settlement and
withdrawal. Settlement credits the recipient bound at commit; withdrawal is a separate
transaction. Challenge #3 credited **0.01 testnet MON**, and that reward was subsequently
withdrawn. Synthetic shopping amounts in SYN are unrelated to testnet MON.

ERC-8004 is used for agent identity and reputation, not execution verification. The
publisher registered the exact historical adapter digests in the IdentityRegistry: agent
2190 is the intentionally vulnerable fixture and agent 2192 is live-model version 0.1.1.
A separate reporter rechecks the settlement and evidence before posting
`counterproof.verifiedViolation`, with R1 or R5 as the second tag, to the ReputationRegistry.
These registrations and feedback do not make the evaluator trustless, and the historical
identity is not a registration of repaired version 0.2.0.

| Submission link | URL |
|---|---|
| Public code | https://github.com/professor-200629/counterproof |
| Hosted recorded evidence | https://counterproof.vercel.app/ |
| Monad testnet contract, chain 10143 | https://testnet.monadscan.com/address/0xE37720f40BC214Ce084595111B1Ee4F4d454b5e4 |
| Historical source tag | https://github.com/professor-200629/counterproof/tree/testnet-2026-10-11 |
| Reproduction guide | https://github.com/professor-200629/counterproof/blob/main/docs/REPRODUCE.md |
| Original R5 evidence | https://counterproof.vercel.app/evaluations/eval_b5c4cb6315eb4172 |
| Recorded before/after | https://counterproof.vercel.app/challenges/3/compare |
| Settlement and withdrawal | https://counterproof.vercel.app/challenges/3/settlement |
| R5 commitment | https://testnet.monadscan.com/tx/0xdbf0207722a5c6c1b5ed3732b86123d2c9ec2bf16bb2905b2a1e727e1c123c3e |
| R5 settlement (reward credited) | https://testnet.monadscan.com/tx/0xea911f1af55278f3b66290d627c71b27cf8bf75d0bb6e6e28775da61e1261e89 |
| R5 withdrawal | https://testnet.monadscan.com/tx/0xf8959634cb0d4908dd098c7006b23a6afbbf069af5c37ea530496c19e50defe5 |
| ERC-8004 IdentityRegistry | https://testnet.monadscan.com/address/0x8004A818BFB912233c491871b3d84c89A494BD9e |
| Agent 2192 registration | https://testnet.monadscan.com/tx/0x101bec63f9eb307382479e1e2367e7f4c1592a4749f65ea3954f52f71dc369f2 |
| ERC-8004 ReputationRegistry | https://testnet.monadscan.com/address/0x8004B663056A597Dffe9eCcC1965A193B7388713 |
| Agent 2192 R5 feedback | https://testnet.monadscan.com/tx/0x643d7ec3b873868797053f263ed3f599e08d7e465205f16a4bdb6820e9e5a3c5 |
| Download regression JSON | https://counterproof.vercel.app/snapshot/api/regressions/reg_1f9d7ee2fbb64948/export.json |
| Download regression pytest | https://counterproof.vercel.app/snapshot/api/regressions/reg_1f9d7ee2fbb64948/export.pytest.txt |

The local changes prepared in this session need publication before `main` links expose
the new clean-clone guide and final package. The historical hosted evidence and public
code already exist; deployment history is recorded in [REMEDIATION_REPORT.md](REMEDIATION_REPORT.md).

## Build-window, provenance, licences and limitations

Repository history begins on **6 October 2026** (`628440a`); recorded project commits
through 13 October fall within the official portal's published 1 September–13 October
window. This establishes the recorded commit dates, not proof of when every line was
first authored or a portal eligibility ruling. The team must make any requested prior-work
declaration truthfully. Existing libraries, toolchains, standards and the hosted model
were not created for this hackathon. AI coding assistants were used throughout, under the
owner's direction: Claude Code (Anthropic) from the first commit, writing most of the code,
tests and documentation (every commit carries a `Co-Authored-By: Claude` trailer), and
OpenAI Codex for part of the 13 October submission fixes. The README's "AI tooling" section
is the disclosure the rules ask for. All evaluated adapter prompts and loops are
team-written; no external-agent evaluation or independent human reproduction has been completed.

The owner approved a repository-wide **MIT** [LICENSE](../LICENSE) for first-party code
in this session; it must be published with the release. The reward contract source also
declares MIT. OpenZeppelin is an existing MIT dependency;
forge-std retains its upstream MIT/Apache-2.0 notices. Backend and web dependency versions
are retained in `backend/uv.lock` and `web/pnpm-lock.yaml`. The current portal explicitly
requires an OSI-approved LICENSE, so publish the approved licence before submitting.
The owner's licence decision is recorded in [LICENSING_PROPOSAL.md](LICENSING_PROPOSAL.md). Do not
remove dependency notices. Proposed external adapters are documented, licence-checked
candidates only; they are not shipped integrations.

Other limits: testnet only; one declared evaluator and no dispute mechanism; bounded
search and model/provider/date dependence; five explicit rules rather than arbitrary
natural-language promises; process isolation is not a hostile-code sandbox; container
isolation remains unverified because Docker is unavailable here. Linux/macOS instructions
are untested. Browser-wallet execution on testnet has not been checked. No pilot users,
testimonials, outside approval or successful external integrations are claimed.

## Go-to-market response

We have no users or revenue yet. Our first audience is teams developing purchasing or
payment agents and researchers who already find reproducible failure cases. We plan
to make regression export the free entry point, obtain an independent human reproduction,
and integrate one external open-source shopping agent once safe container isolation is
available. Next we would invite a small number of teams to try public challenges with
modest rewards and measure completed reproductions, time from finding to repair, and
repeat challenge participation. These are planned activities, not completed pilots.

If that produces repeat demand, the proposed business is hosted evaluators and private
challenges. We would publish evaluator keys and execution policies and add independent
evaluators as trust requirements grow. Adoption, pricing and willingness to pay remain
unvalidated. ERC-8004 feedback is the implemented portability mechanism; no integration
with an external marketplace is claimed.

## Video and logo fields

- **Technical demo URL: PENDING — no checked video file or real link exists.** Record using
  [DEMO_SCRIPT.md](DEMO_SCRIPT.md), targeting at most 3:00 under the currently verified limit.
- **Pitch video URL: PENDING — no checked video file or real link exists.** Record using
  [PITCH.md](PITCH.md), targeting at most 2:00 under the previously recorded limit.
- **Logo:** existing [SVG](brand/logo.svg) and its visually checked
  [PNG](brand/logo.png), **512 × 512 pixels, 19,277 bytes**. They preserve the existing
  CounterProof broken-check branding. Portal accepted format, dimensions and file size
  limits remain unverified; use the PNG only if the signed-in form accepts it.

## Submission checklist

- [x] Name, tagline, measured short description and one primary track prepared.
- [x] Problem, product, implementation, differentiation and honest go-to-market text prepared.
- [x] Monad contract, original/repair comparison, receipts and ERC-8004 links supplied.
- [x] Fresh local execution distinguished from the hosted read-only snapshot.
- [x] Historical build/source provenance, owner-approved MIT licence and limitations disclosed.
- [x] Existing logo retained and PNG rendition visually checked.
- [x] Offline records verification and scripted adapter execution have distinct commands in
  [REPRODUCE.md](REPRODUCE.md); live mode is explicit and uses the reader's own key.
- [ ] Publish the reviewed local fixes and verify the release URLs after publication.
- [x] Current signed-in rules, deadline, runnable-prototype wording, public code/LICENSE
  requirement, 3-minute technical demo and 120/200-character Overview limits verified.
- [ ] Owner creates the project and checks the final Submission fields, pitch and logo
  limits; no snapshot-only eligibility claim is made.
- [x] Owner selected and authorized the repository-wide MIT licence; local LICENSE added.
- [ ] Publish LICENSE and README attribution/AI disclosures; owner confirms requested
  prior-work declarations and reviews legal terms.
- [ ] Record and check both video files for duration, sound, legibility and honest cuts;
  upload them and paste real accessible links above.
- [ ] Owner submits the portal form and saves its confirmation before the deadline.
- [ ] External-agent evaluation: pending milestone after safe isolation is available.
- [ ] Independent human reproduction: pending; an outside person must actually execute the kit.
