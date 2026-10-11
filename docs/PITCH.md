# Pitch (≤ 2:00)

**Problem (0:00–0:25).** AI agents are starting to spend money. Their builders make
promises — "it never exceeds the budget", "it never pays twice" — and test them
themselves. When a promise breaks, there is no shared way to prove it, reproduce it, or
reward the person who found it.

**Product (0:25–1:05).** CounterProof turns a promise into a funded, executable challenge
on Monad. The developer approves exact rules and funds a reward. Challengers search for
counterexamples. Our evaluator replays every candidate in a fresh isolated environment, a
deterministic checker reads the evaluator's own ledger — never the agent's word — and a
separate signer attests the result. The contract pays only the recipient the challenger
bound on chain when committing to that exact candidate — whoever relays the transaction.
Then the counterexample becomes a regression test for the fixed version, and a verified
result is written to the agent's ERC-8004 reputation on Monad, so anyone choosing an agent
can see it.

**Honesty (1:05–1:25).** We say exactly what a result means. "No violation found" is not
proof of safety. Our evaluator is a declared trusted party: a signed attestation, not a
zero-knowledge proof. Our demo failure comes from a reference agent with planted defects,
and we label it so. Then we pointed it at a live-model agent with no planted defects: injected
shop text talked it into trying to raise its own budget, in 3 of 3 independent replays. The
market refused the change, and the evidence is public.

**Why Monad (1:25–1:40).** Fund, commit, settle and withdraw are small, frequent
transactions; with sub-second blocks the payout confirms while the evidence is still on
screen.

**Ask (1:40–2:00).** Validators check what an agent did. CounterProof pays people to break
what it promised, and turns every break into a test and a reputation record. Next: more agent
adapters, multiple independent evaluators, and public challenges against open-source agents.
CounterProof: put AI promises to the test.
