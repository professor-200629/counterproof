"""Shared search harness: budgets, execution, local rule checks, shrinking, records."""

from __future__ import annotations

import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Iterable, Iterator

from ..canonical import digest
from ..market.actions import parse_actions
from ..rules.checker import check
from ..runner.sandbox import IsolationUnavailable, select_backend
from ..runner.session import RunLimits, run_sequence
from . import STRATEGY_VERSION


@dataclass
class Budget:
    max_sequences: int = 120
    max_wall_seconds: int = 90
    max_model_calls: int = 0
    max_model_tokens: int = 0
    max_cost_usd_micros: int = 0  # integer micro-dollars, 0 = no paid inference allowed
    shrink: bool = True

    def as_dict(self) -> dict:
        return dict(self.__dict__)


@dataclass
class SearchRecord:
    strategy: str
    strategy_version: str
    params: dict
    budget: dict
    sequences_tried: int = 0
    tool_calls: int = 0
    model_calls: int = 0
    model_tokens: int = 0
    candidates: list[dict] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    run_outcomes: dict = field(default_factory=dict)
    samples: list[dict] = field(default_factory=list)
    termination: str = ""
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    rules_violated: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        d = dict(self.__dict__)
        d["duration_ms"] = int(((self.finished_at or time.time()) - self.started_at) * 1000)
        return d


class Harness:
    def __init__(self, *, spec: dict, spec_dgst: str, strategy: str, params: dict, budget: Budget,
                 challenger: str, recipient: str, run_id: str, cancel: threading.Event | None = None,
                 progress: Callable[[dict], None] | None = None, broker=None, model_label: str | None = None):
        self.spec = spec
        self.spec_dgst = spec_dgst
        self.budget = budget
        self.cancel = cancel or threading.Event()
        self.progress = progress
        self.broker = broker
        self.challenger = challenger.lower()
        self.recipient = recipient.lower()
        self.run_id = run_id
        self.model_label = model_label
        self.limits = RunLimits.from_spec(spec["limits"])
        self.adapter_key = f"{spec['target']['adapter']}@{spec['target']['version']}"
        self.record = SearchRecord(strategy, STRATEGY_VERSION, params, budget.as_dict())
        self.deadline = time.monotonic() + budget.max_wall_seconds
        self.child = None
        self.backend = None
        self.found_rules: set[str] = set()
        self.seen: set[str] = set()

    # ------------------------------------------------------------------ budget
    def exhausted(self) -> str | None:
        if self.cancel.is_set():
            return "cancelled"
        if self.record.sequences_tried >= self.budget.max_sequences:
            return "sequence budget exhausted"
        if time.monotonic() >= self.deadline:
            return "wall-clock budget exhausted"
        if self.budget.max_model_calls and self.record.model_calls >= self.budget.max_model_calls:
            return "model-call budget exhausted"
        if self.budget.max_model_tokens and self.record.model_tokens >= self.budget.max_model_tokens:
            return "model-token budget exhausted"
        return None

    # ------------------------------------------------------------------ execution
    def _ensure_backend(self):
        if self.backend is None:
            self.backend = select_backend(self.spec["environment"]["isolation"])
        return self.backend

    def run(self, actions: list[dict], *, count: bool = True) -> tuple[str, list[dict], dict]:
        """Run one sequence; returns (run outcome, violations, stats)."""
        backend = self._ensure_backend()
        res, self.child = run_sequence(backend=backend, adapter_key=self.adapter_key, config=self.spec["target"]["config"],
                                       initial_state=self.spec["initial_state"], actions=actions, limits=self.limits,
                                       broker=self.broker, cancel=self.cancel, child=self.child)
        if count:
            self.record.sequences_tried += 1
        self.record.tool_calls += res.stats.get("tool_calls", 0)
        self.record.model_calls += res.stats.get("model_calls", 0)
        usage = res.stats.get("model_usage") or {}
        self.record.model_tokens += int(usage.get("prompt_tokens", 0)) + int(usage.get("completion_tokens", 0))
        self.record.run_outcomes[res.outcome] = self.record.run_outcomes.get(res.outcome, 0) + 1
        if res.outcome == "runner_failure":
            raise IsolationUnavailable(res.reason)
        violations = check(self.spec["rules"], res.ledger_events)
        if len(self.record.samples) < 12 and count:
            self.record.samples.append({"actions": actions, "outcome": res.outcome,
                                        "violated": [v["rule_id"] for v in violations]})
        return res.outcome, violations, res.stats

    def _shrink(self, actions: list[dict], rule_id: str) -> list[dict]:
        """Greedy one-at-a-time deletion while the same rule stays violated. Shrink runs
        do not count against the sequence budget but do respect the wall clock."""
        current = list(actions)
        changed = True
        while changed and len(current) > 1 and time.monotonic() < self.deadline and not self.cancel.is_set():
            changed = False
            for i in range(len(current)):
                trial = current[:i] + current[i + 1:]
                if not any(a["type"] == "user_request" for a in trial):
                    continue
                _, vs, _ = self.run(trial, count=False)
                if any(v["rule_id"] == rule_id for v in vs):
                    current = trial
                    changed = True
                    break
        return current

    def candidate(self, actions: list[dict], violation: dict, note: str = "") -> dict:
        cand = {
            "format": "counterproof.candidate/v1",
            "challenge_spec_digest": self.spec_dgst,
            "challenger": self.challenger,
            "recipient": self.recipient,
            "claimed_rule": violation["rule_id"],
            "actions": actions,
            "salt": "0x" + secrets.token_hex(32),
            "provenance": {"strategy": self.record.strategy, "strategy_version": STRATEGY_VERSION,
                           "run_id": self.run_id, "model": self.model_label, "note": note[:300]},
        }
        return {"candidate": cand, "digest": digest(cand), "local_check": {
            "rule_id": violation["rule_id"], "summary": violation["summary"], "observed": violation["observed"],
            "note": "challenger-side self-check only; not evidence until the evaluator replays it"}}

    def explore(self, sequences: Iterable[list[dict]]) -> SearchRecord:
        """Drive a strategy's proposals until the budget ends or every rule is hit."""
        rule_ids = {r["id"] for r in self.spec["rules"]}
        it: Iterator[list[dict]] = iter(sequences)
        try:
            while True:
                why = self.exhausted()
                if why:
                    self.record.termination = why
                    break
                try:
                    proposal = next(it)
                except StopIteration:
                    self.record.termination = "search space exhausted"
                    break
                try:
                    actions = parse_actions(proposal)
                except Exception as e:  # a strategy bug or a model proposal outside the schema
                    self.record.errors.append(f"invalid proposal skipped: {str(e)[:160]}")
                    continue
                if len(actions) > self.spec["scope"]["max_actions"] or any(
                        a["type"] not in self.spec["scope"]["allowed_actions"] for a in actions):
                    self.record.errors.append("proposal outside the challenge scope skipped")
                    continue
                key = digest(actions)
                if key in self.seen:
                    continue
                self.seen.add(key)
                outcome, violations, _ = self.run(actions)
                for v in violations:
                    if v["rule_id"] in self.found_rules:
                        continue
                    minimal = self._shrink(actions, v["rule_id"]) if self.budget.shrink else actions
                    _, vs, _ = self.run(minimal, count=False)
                    final = next((x for x in vs if x["rule_id"] == v["rule_id"]), v)
                    self.found_rules.add(v["rule_id"])
                    self.record.candidates.append(self.candidate(minimal, final,
                                                                 note=f"shrunk from {len(actions)} to {len(minimal)} actions"))
                if self.progress:
                    self.progress(self.record.as_dict())
                if self.found_rules >= rule_ids:
                    self.record.termination = "every rule in the challenge has a candidate"
                    break
        except IsolationUnavailable as e:
            self.record.errors.append(f"isolation unavailable: {e}")
            self.record.termination = "failed closed: isolation unavailable"
        finally:
            if self.child is not None:
                self.child.close()
                self.child = None
            self.record.finished_at = time.time()
            self.record.rules_violated = sorted(self.found_rules)
            if self.progress:
                self.progress(self.record.as_dict())
        return self.record
