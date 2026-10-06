"""Parent-side replay driver.

`run_sequence` resets a fresh `Market` to the committed initial state, feeds the
validated action sequence to the environment, relays the agent's tool calls (and model
requests, through a broker that holds any provider key), enforces limits and returns the
authoritative ledger plus a parent-recorded trace.

Outcome of a single run (before rule checks):
  completed       the agent handled every action
  target_crash    the agent exited, broke the protocol or exceeded a call limit
  timeout         an event or the whole run exceeded its wall-clock limit
  runner_failure  the sandbox could not be started or the evaluator failed
  cancelled       cancellation was requested
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from ..canonical import digest
from ..market.engine import Market
from .protocol import ProtocolError
from .sandbox import Child, ChildGone, ChildTimeout, IsolationUnavailable, ResourceLimits


@dataclass
class RunLimits:
    max_tool_calls_per_event: int = 24
    max_tool_calls_total: int = 160
    max_model_calls: int = 0
    event_timeout_ms: int = 15_000
    total_timeout_ms: int = 60_000
    memory_mb: int = 256
    cpu_seconds: int = 20

    @classmethod
    def from_spec(cls, limits: dict) -> "RunLimits":
        return cls(**{k: limits[k] for k in cls.__dataclass_fields__ if k in limits})


@dataclass
class RunResult:
    outcome: str
    reason: str
    ledger_events: list[dict]
    ledger_digest: str
    trace: list[dict]
    claims: list[str]
    stats: dict = field(default_factory=dict)
    isolation: dict = field(default_factory=dict)

    @property
    def trace_digest(self) -> str:
        return digest(self.trace)


class BrokerRefused(Exception):
    """A model request the broker could not serve. `kind` is "provider" (the provider
    failed or was unreachable), "budget" (the spec's model budget is spent) or "request"
    (malformed request from the target)."""

    def __init__(self, message: str, kind: str = "provider"):
        super().__init__(message)
        self.kind = kind


def _bounded(value: Any, limit: int = 4000) -> Any:
    """Keep traces small and canonical-safe (no floats)."""
    import json

    text = json.dumps(value, default=str)
    if len(text) <= limit:
        return json.loads(text, parse_float=lambda s: s)
    return {"truncated": True, "preview": text[:limit]}


def start_child(backend, adapter_key: str, config: dict, uses_model: bool, limits: RunLimits) -> Child:
    child = backend.spawn(ResourceLimits(memory_mb=limits.memory_mb, cpu_seconds=limits.cpu_seconds))
    try:
        child.send({"kind": "init", "adapter_key": adapter_key, "config": config, "model": uses_model})
        ready = child.recv(timeout=15)
        if ready.get("kind") != "ready":
            raise ProtocolError(f"expected ready, got {ready.get('kind')}: {ready.get('error', '')}")
    except Exception:
        child.close(graceful=False)
        raise
    return child


def run_sequence(
    *,
    backend,
    adapter_key: str,
    config: dict,
    initial_state: dict,
    actions: list[dict],
    limits: RunLimits,
    broker: Callable[[dict], dict] | None = None,
    cancel: threading.Event | None = None,
    child: Child | None = None,
) -> tuple[RunResult, Child | None]:
    """Run one sequence. If `child` is given it is reused after a `reset` (challenger-side
    search only); the evaluator always passes child=None so every replay is fresh.
    Returns the result and the child if it is still healthy (else None)."""
    market = Market(initial_state)
    trace: list[dict] = []
    claims: list[str] = []
    t0 = time.monotonic()
    deadline = t0 + limits.total_timeout_ms / 1000
    tool_calls = 0
    model_calls = 0
    model_usage = {"prompt_tokens": 0, "completion_tokens": 0}
    reused = child is not None

    def result(outcome: str, reason: str, keep: bool) -> tuple[RunResult, Child | None]:
        nonlocal child
        stats = {"tool_calls": tool_calls, "model_calls": model_calls, "model_usage": model_usage,
                 "duration_ms": int((time.monotonic() - t0) * 1000), "actions": len(actions), "reused_child": reused}
        iso = dict(child.info.detail) if child else {}
        if child is not None and not keep:
            if outcome != "completed":
                stats["stderr_tail"] = child.stderr_text()[-1000:]
                code = child.exit_code(wait=0.5)
                if code is not None:
                    stats["exit_code"] = code
            child.close(graceful=outcome == "completed")
            iso = dict(child.info.detail)
            child = None
        r = RunResult(outcome, reason, market.ledger.events, market.ledger.digest, trace, claims, stats, iso)
        return r, child

    try:
        if child is None:
            child = start_child(backend, adapter_key, config, broker is not None, limits)
        else:
            child.send({"kind": "reset"})
            if child.recv(timeout=10).get("kind") != "reset_done":
                raise ProtocolError("child did not reset")
    except IsolationUnavailable as e:
        return result("runner_failure", f"isolation unavailable: {e}", keep=False)
    except (ChildGone, ChildTimeout, ProtocolError, OSError) as e:
        return result("runner_failure", f"sandbox did not start: {type(e).__name__}: {e}", keep=False)

    for index, action in enumerate(actions):
        if cancel is not None and cancel.is_set():
            return result("cancelled", "cancellation requested", keep=False)
        event = market.apply_action(action)
        if event is None:
            continue
        event_deadline = min(deadline, time.monotonic() + limits.event_timeout_ms / 1000)
        event_calls = 0
        try:
            child.send({"kind": "event", "event": event})
            while True:
                if cancel is not None and cancel.is_set():
                    return result("cancelled", "cancellation requested", keep=False)
                remaining = event_deadline - time.monotonic()
                if remaining <= 0:
                    raise ChildTimeout()
                try:
                    # poll in short slices so a cancellation request is noticed promptly
                    msg = child.recv(timeout=min(remaining, 0.5) if cancel is not None else remaining)
                except ChildTimeout:
                    if cancel is not None and time.monotonic() < event_deadline:
                        continue
                    raise
                kind = msg["kind"]
                if kind == "call":
                    tool_calls += 1
                    event_calls += 1
                    if event_calls > limits.max_tool_calls_per_event or tool_calls > limits.max_tool_calls_total:
                        child.send({"kind": "abort", "reason": "tool call limit"})
                        return result("target_crash", f"tool call limit exceeded at action {index}", keep=False)
                    resp = market.call(msg.get("tool"), msg.get("args"))
                    trace.append({"n": tool_calls, "action_index": index, "tool": _bounded(msg.get("tool"), 80),
                                  "args": _bounded(msg.get("args"), 1000), "response": _bounded(resp, 3000)})
                    child.send({"kind": "result", "id": msg.get("id"), **resp})
                elif kind == "model":
                    model_calls += 1
                    if broker is None:
                        child.send({"kind": "model_result", "id": msg.get("id"), "ok": False, "error": "no model broker"})
                        continue
                    if model_calls > limits.max_model_calls:
                        child.send({"kind": "abort", "reason": "model call limit"})
                        return result("target_crash", f"model call limit exceeded at action {index} (resource limit)", keep=False)
                    try:
                        out = broker(msg.get("request") or {})
                    except BrokerRefused as e:
                        trace.append({"n": tool_calls, "action_index": index, "model_call": model_calls,
                                      "refused": str(e)[:300], "refusal_kind": e.kind})
                        if e.kind == "provider":
                            # The agent cannot act without its model: this replay says nothing about the
                            # agent and must never be read as "no violation".
                            child.send({"kind": "abort", "reason": "model provider unavailable"})
                            return result("runner_failure", f"model provider unavailable during action {index}: {str(e)[:200]}",
                                          keep=False)
                        if e.kind == "budget":
                            child.send({"kind": "abort", "reason": "model budget exhausted"})
                            return result("target_crash", f"model budget exhausted at action {index} (resource limit)", keep=False)
                        child.send({"kind": "model_result", "id": msg.get("id"), "ok": False, "error": str(e)[:300]})
                        continue
                    usage = out.get("usage") or {}
                    for k in model_usage:
                        model_usage[k] += int(usage.get(k) or 0)
                    trace.append({"n": tool_calls, "action_index": index, "model_call": model_calls,
                                  "model": out.get("model"), "usage": _bounded(usage, 400)})
                    child.send({"kind": "model_result", "id": msg.get("id"), "ok": True, "response": out})
                elif kind == "event_done":
                    claims.append(str(msg.get("claim", ""))[:500])
                    break
                elif kind == "fatal":
                    return result("target_crash", f"agent raised: {str(msg.get('error'))[:300]}", keep=False)
                else:
                    return result("target_crash", f"protocol violation: unexpected {kind!r}", keep=False)
        except ChildTimeout:
            which = "run" if time.monotonic() >= deadline else f"action {index}"
            return result("timeout", f"time limit exceeded during {which}", keep=False)
        except ChildGone:
            return result("target_crash", f"agent process exited during action {index}", keep=False)
        except ProtocolError as e:
            return result("target_crash", f"protocol violation: {e}", keep=False)

    return result("completed", "all actions handled", keep=True)


def run_fresh(**kwargs: Any) -> RunResult:
    """One run in a brand-new child that is torn down afterwards (evaluator replays)."""
    res, child = run_sequence(child=None, **kwargs)
    if child is not None:
        child.close(graceful=True)
        res.isolation = dict(child.info.detail)
    return res
