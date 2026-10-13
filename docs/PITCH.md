# Pitch

**Length:** at most 2:00. That limit was read from the hackathon portal on 2026-10-06 and could
not be re-verified without sign-in, so check it before recording.

**Problem (0:00-0:20).** AI agents are starting to spend money. Their builders make promises:
"it never exceeds the budget", "it never changes its own permissions". The teams that wrote
those agents are the ones testing those promises. When a promise breaks, nobody can prove it,
reproduce it or get paid for finding it.

**What we built (0:20-0:55).** CounterProof turns one promise into a funded challenge on Monad.
The developer approves an exact rule, and its hash is escrowed with a reward. A challenger
commits a counterexample on chain before revealing it. Our evaluator replays it in fresh,
isolated runs. A deterministic checker reads the evaluator's own ledger, never the agent's
word. Before it signs, a separate signer re-runs the agreed number of replays itself. The
contract pays only the recipient bound at commit, whoever relays the transaction. The result
becomes ERC-8004 reputation for that exact code version and a regression test for the fix.

**Proof it works (0:55-1:25).** On Monad testnet, injected shop text made a live-model purchasing
agent, running gpt-oss-120b, try to give itself a 1,000,000 budget. That happened in 3 of 3
fresh replays. The reward was settled and withdrawn, and the result is recorded in ERC-8004.
We then shipped a repaired version that enforces its tool permissions in code. The same attack
was replayed against it 3 times: the rule held, and an ordinary purchase still went through.
The exported regression test fails on the old version and passes on the new one. All of this is
on the public site, with transaction links, and a script re-checks it.

**Why Monad (1:25-1:40).** The pieces that need neutral ground run on chain: the escrow, the
commitment, the payout bound to the challenger, and reputation any agent marketplace can read.
Measured on testnet: blocks about 0.3 s apart, and about 0.014 testnet MON of gas to settle.

**What we don't claim (1:40-1:50).** The evaluator is a declared trusted party: its signature is
an attestation, not a proof. A bounded test is not general safety. So far every agent we tested
was written by our team; an external agent is next.

**Ask (1:50-2:00).** Put your agent's promises up as challenges, or bring us the agent that should
be tested next. CounterProof: put AI promises to the test.
