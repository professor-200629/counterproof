"""Replay an exported regression test against an installed target adapter.

Every replay really executes the adapter: a fresh child process from the committed initial
state, the recorded action sequence, and the deterministic checker over the new ledger.
Nothing here returns a recorded verdict.

Live-model targets (requires_model) are replayed with a `ScriptedBroker` by default: the
model's recorded proposals from the original evaluation are served back turn by turn, so
the test is offline and deterministic. It tests what the agent's code does with those
proposals - for example whether a privileged call is refused before it reaches the market -
not what a model would propose today. `replay_regression_live` asks the real model instead
(k-of-n, needs COUNTERPROOF_REGRESSION_LIVE=1 and the provider's API key) and is never the
default.
"""

from __future__ import annotations

import json
import os

from .market.actions import parse_actions
from .rules.checker import check
from .runner.sandbox import select_backend
from .runner.session import RunLimits, run_fresh
from .targets import registry

FORMAT = "counterproof.regression/v1"
LIVE_ENV = "COUNTERPROOF_REGRESSION_LIVE"


class ScriptedBroker:
    """Serves recorded model turns instead of calling a provider.

    `turns` come from `recorded_model_proposals.turns` of a regression export: each is
    {"event": n, "tool_calls": [{"name", "arguments"}], "text"?}. On each request the broker
    works out which principal request the conversation is on (the number of user messages),
    returns that event's next recorded turn as the model's response, and once the event's
    turns are used up answers with the recorded final text (or "Done."). Turns the provider
    rejected in the original run (status other than "ok") cannot be replayed and are skipped.
    A new conversation (a fresh replay) starts from the first turn again."""

    def __init__(self, turns: list[dict], label: str = "scripted-replay"):
        self.label = label
        self.by_event: dict[int, list[dict]] = {}
        self.final: dict[int, str] = {}
        for t in turns:
            ev = int(t.get("event") or 1)
            if t.get("status", "ok") != "ok":
                continue
            if t.get("tool_calls"):
                self.by_event.setdefault(ev, []).append(t)
            elif isinstance(t.get("text"), str):
                self.final.setdefault(ev, t["text"])
        self.pos: dict[int, int] = {}
        self.calls = 0

    def __call__(self, request: dict) -> dict:
        msgs = request.get("messages") or []
        event = max(1, sum(1 for m in msgs if isinstance(m, dict) and m.get("role") == "user"))
        if event == 1 and not any(isinstance(m, dict) and m.get("role") == "assistant" for m in msgs):
            self.pos = {}  # a fresh conversation: replay from the start
        self.calls += 1
        i = self.pos.get(event, 0)
        turns = self.by_event.get(event, [])
        if i < len(turns):
            self.pos[event] = i + 1
            calls = [{"id": f"call_{event}_{i}_{j}", "type": "function",
                      "function": {"name": c["name"], "arguments": json.dumps(c.get("arguments") or {})}}
                     for j, c in enumerate(turns[i]["tool_calls"])]
            return {"model": self.label, "finish_reason": "tool_calls",
                    "message": {"role": "assistant", "content": "", "tool_calls": calls},
                    "usage": {"prompt_tokens": 0, "completion_tokens": 0}}
        return {"model": self.label, "finish_reason": "stop",
                "message": {"role": "assistant", "content": self.final.get(event) or "Done.", "tool_calls": []},
                "usage": {"prompt_tokens": 0, "completion_tokens": 0}}


def _check_file(regression: dict, target_key: str):
    if regression.get("format") != FORMAT:
        raise ValueError("not a CounterProof regression file")
    info = registry.get(target_key)
    t = regression.get("target") or {}
    if t.get("adapter") and t["adapter"] != info.adapter:
        raise ValueError(f"{target_key} is a different agent from {t['adapter']}; a regression replays one agent's "
                         "counterexample against versions of the same agent")
    return info, t


def _limits(regression: dict, info) -> RunLimits:
    if regression.get("limits"):
        return RunLimits.from_spec(regression["limits"])
    if info.requires_model:
        raise ValueError("this regression file has no limits for a live-model target; export it again")
    return RunLimits()


def _result(target_key: str, mode: str, regression: dict, res) -> dict:
    violations = check(regression["rules"], res.ledger_events)
    return {"target": target_key, "artifact_digest": registry.artifact_digest(target_key), "mode": mode,
            "run_outcome": res.outcome, "run_reason": res.reason, "ledger_digest": res.ledger_digest,
            "rules_violated": [v["rule_id"] for v in violations], "violations": violations,
            "ledger": res.ledger_events, "trace": res.trace, "claims": res.claims, "stats": res.stats}


def replay_regression(regression: dict, target_key: str, isolation: str = "process", broker=None) -> dict:
    """One fresh replay of the regression's action sequence against `target_key`.
    Live-model targets get the recorded proposals through a ScriptedBroker unless a broker
    is passed explicitly."""
    info, t = _check_file(regression, target_key)
    config: dict = {}
    mode = "deterministic"
    if info.requires_model:
        config = dict(t.get("config") or {})
        if not config:
            raise ValueError("this regression file has no target config for a live-model target; export it again")
        if broker is None:
            rec = regression.get("recorded_model_proposals") or {}
            if not rec.get("turns"):
                raise ValueError("this regression file has no recorded model proposals to replay")
            broker = ScriptedBroker(rec["turns"], label=f"scripted-replay of {rec.get('model') or 'recorded model'}")
            mode = "scripted"
        else:
            mode = "broker"
    res = run_fresh(backend=select_backend(isolation), adapter_key=target_key, config=config,
                    initial_state=regression["initial_state"], actions=parse_actions(regression["actions"]),
                    limits=_limits(regression, info), broker=broker)
    return _result(target_key, mode, regression, res)


def replay_regression_live(regression: dict, target_key: str, isolation: str = "process") -> dict:
    """k-of-n against the real model named in the file (provider, model, temperature).
    Opt-in only: requires COUNTERPROOF_REGRESSION_LIVE=1 and the provider's API key. A
    provider failure is reported as runner_failure, never as a pass."""
    if os.environ.get(LIVE_ENV) != "1":
        raise RuntimeError(f"live regression replays are opt-in: set {LIVE_ENV}=1 and the provider's API key")
    from .providers import broker_for_spec

    info, t = _check_file(regression, target_key)
    if not info.requires_model:
        raise ValueError(f"{target_key} needs no model; use replay_regression")
    repro = regression.get("reproducibility") or {"replays": 3, "required_violations": 2}
    spec_like = {"target": {"determinism": "stochastic", "config": t.get("config") or {}},
                 "limits": regression["limits"], "reproducibility": repro}
    broker = broker_for_spec(spec_like, None)
    if broker is None:
        raise ValueError("this regression file names no model provider")
    rule = regression["rule"]["id"]
    runs = []
    for _ in range(repro["replays"]):
        r = replay_regression(regression, target_key, isolation=isolation, broker=broker)
        r["mode"] = "live"
        runs.append({k: r[k] for k in ("run_outcome", "run_reason", "rules_violated", "ledger_digest", "claims")})
        if r["run_outcome"] == "runner_failure":
            break
    hits = sum(rule in r["rules_violated"] for r in runs)
    if any(r["run_outcome"] == "runner_failure" for r in runs):
        outcome = "runner_failure"
    elif hits >= repro["required_violations"]:
        outcome = "violated"
    elif hits == 0 and all(r["run_outcome"] == "completed" for r in runs):
        outcome = "not_violated"
    else:
        outcome = "inconclusive"
    return {"target": target_key, "mode": "live", "model": f"{broker.client.provider}/{broker.client.model}",
            "outcome": outcome, "violations": hits, "replays": len(runs),
            "required_violations": repro["required_violations"], "runs": runs}
