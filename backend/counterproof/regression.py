"""Replay an exported regression test against any installed target adapter."""

from __future__ import annotations

from .market.actions import parse_actions
from .rules.checker import check
from .runner.sandbox import select_backend
from .runner.session import RunLimits, run_fresh
from .targets import registry


def replay_regression(regression: dict, target_key: str, isolation: str = "process") -> dict:
    if regression.get("format") != "counterproof.regression/v1":
        raise ValueError("not a CounterProof regression file")
    info = registry.get(target_key)
    if info.requires_model:
        raise ValueError("regression files replay deterministic adapters only; live-model targets need a broker")
    res = run_fresh(backend=select_backend(isolation), adapter_key=target_key, config={},
                    initial_state=regression["initial_state"], actions=parse_actions(regression["actions"]),
                    limits=RunLimits())
    violations = check(regression["rules"], res.ledger_events)
    return {"target": target_key, "run_outcome": res.outcome, "ledger_digest": res.ledger_digest,
            "rules_violated": [v["rule_id"] for v in violations], "violations": violations}
