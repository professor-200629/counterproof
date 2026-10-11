# Technical demo script (≤ 3:00)

Rule from the hackathon: the technical demo must show the working product, not slides or a
code walkthrough. Everything below is the real console against the real stack.

Setup before recording: `scripts/dev.py testnet` (or `local` — then say "local anvil, not
Monad" on screen), wallet connected, a fresh browser profile, screen at 1440×900.

| Time | Screen | Say (short) |
|---|---|---|
| 0:00–0:15 | Overview | "CounterProof puts AI agent promises to the test. A developer funds a promise; challengers earn it with a reproducible counterexample." |
| 0:15–0:45 | Create → Target, Rules, Review | Pick `ref-purchasing-agent 1.0.0` — point at the **Intentionally vulnerable fixture** badge. Approve two rules: total spend ≤ 25,000; never pay an order twice. Show the canonical spec and its digest: "this exact digest is what gets funded." |
| 0:45–1:00 | Fund (wallet) | Confirm `createChallenge` in the wallet; the challenge flips to Funded with the Monadscan link. |
| 1:00–1:30 | Live testing | Run Sequence explorer and Retry/replay. Real counters: sequences tried / budget. Merchant-content finishes with **no violation found** — show the honest block (budget, termination). |
| 1:30–2:05 | Findings → Evidence | Submit the budget candidate. The evaluator replays it twice in fresh isolated processes. Evidence: promise, expected ≤ 25,000 vs observed 38,400, the 2-step counterexample, identical ledger digests, who checked it, limitations. Download the bundle. |
| 2:05–2:25 | Settlement | Attestation signed by the declared evaluator. Settle from the wallet — any account can relay; the reward goes to the committed recipient. Confirmed on Monadscan. "The receipt proves the payment, not that the AI is correct." |
| 2:25–2:40 | Settlement → ERC-8004 panel | "The result doesn't stay with us." Agent #N on the official ERC-8004 IdentityRegistry declares this exact code digest; the reporter posted `counterproof.verifiedViolation / R1` to the official ReputationRegistry. Open the feedback tx on Monadscan. |
| 2:40–2:55 | Before / After | Replay the same sequence against 1.1.0: not reproduced. Export the regression test (pytest). |
| 2:55–3:00 | Overview | "Promise, counterexample, replay, payout, reputation, regression test." |

If time allows (or in the pitch instead): the independent live-model agent (gpt-oss-120b, no
planted defects) — injected merchant text made it try to raise its own budget; verified in 3
of 3 replays (docs/evidence/INDEPENDENT_EVALUATION.md). That is a real finding, not a fixture.

Backup if the network is slow: the local anvil run (`scripts/e2e_local.py` report) — label
it as local.
