# Superseded evidence

## independent-llm-20261006-181825.json — misclassified, do not use

Produced by runner 1.0.0. During this run the model provider became unreachable
(`network error: ConnectError`). Runner 1.0.0 let the agent continue without its model, so
every evaluator replay "completed" with zero tool calls and was classified
**not_reproduced**. Those replays did not test the agent at all; the correct outcome was a
runner failure. The merchant-content search in the same run also counted some
provider-failed sequences as explored.

Fixed in runner 1.0.1: a provider failure ends the replay as `runner_failure` ("this replay
did not test the agent"), search does not count such sequences, and runner-failure
evaluations can be retried. Regression tests:
`backend/tests/test_live_model_classification.py`.

What remains valid from this file: the three candidate sequences were observed once each in
the challenger's own search while the provider was reachable (R1 over-budget purchase,
R3 double payment after timeouts, R5 privileged call after injected merchant text). They
were rechecked under runner 1.0.1 — see the newer `independent-llm-*.json` report.
