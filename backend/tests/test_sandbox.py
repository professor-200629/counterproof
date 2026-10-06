"""Runner limits: memory, CPU/time, crashes, cancellation, secrets, network, protocol."""

import os
import threading
import time

import pytest

from counterproof.market.fixtures import default_world
from counterproof.runner.sandbox import IsolationUnavailable, ProcessBackend, select_backend
from counterproof.runner.session import RunLimits, run_fresh, run_sequence

REQ = [{"type": "user_request", "request_id": "a", "sku": "SKU-PAPER-500", "qty": 1}]


def run(adapter, limits=None, cancel=None, actions=REQ):
    return run_fresh(backend=ProcessBackend(), adapter_key=adapter, config={}, initial_state=default_world(),
                     actions=actions, limits=limits or RunLimits(event_timeout_ms=4000, total_timeout_ms=8000), cancel=cancel)


def pid_gone(pid: int) -> bool:
    import subprocess

    if os.name == "nt":
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}"], capture_output=True, text=True).stdout
        return str(pid) not in out
    try:
        os.kill(pid, 0)
        return False
    except OSError:
        return True


def test_memory_limit_kills_the_target():
    res = run("test-memory-hog@0", RunLimits(memory_mb=96, event_timeout_ms=15000, total_timeout_ms=20000))
    assert res.outcome == "target_crash"
    if os.name == "nt":
        assert res.isolation.get("job_object") is True
        assert res.isolation.get("peak_memory_bytes", 0) <= 96 * 1024 * 1024 + 4096


def test_wall_clock_limit_stops_a_busy_target():
    t = time.monotonic()
    res = run("test-busy-loop@0", RunLimits(event_timeout_ms=1500, total_timeout_ms=5000))
    assert res.outcome == "timeout"
    assert time.monotonic() - t < 10


def test_crash_is_a_target_crash_not_a_violation():
    res = run("test-crash@0")
    assert res.outcome == "target_crash"
    assert res.stats.get("exit_code") == 7


def test_tool_call_flood_hits_the_limit():
    res = run("test-tool-flood@0", RunLimits(max_tool_calls_per_event=10))
    assert res.outcome == "target_crash" and "tool call limit" in res.reason
    assert res.stats["tool_calls"] == 11


def test_protocol_garbage_is_a_target_crash():
    res = run("test-protocol-garbage@0")
    assert res.outcome == "target_crash" and "protocol" in res.reason


def test_target_has_no_network():
    res = run("test-network-probe@0")
    assert res.outcome == "completed"
    assert res.claims[0].startswith("network: blocked")


def test_target_environment_has_no_secrets(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_" + "x" * 40)
    monkeypatch.setenv("EVALUATOR_PRIVATE_KEY", "0x" + "1" * 64)
    res = run("test-env-probe@0")
    names = res.claims[0].removeprefix("env:").split(",")
    assert not any("KEY" in n or "TOKEN" in n or "SECRET" in n for n in names), names
    assert set(names) <= {"PYTHONHASHSEED", "PYTHONDONTWRITEBYTECODE", "PYTHONIOENCODING", "SYSTEMROOT"} | {""}


def test_cancellation_stops_and_cleans_up():
    cancel = threading.Event()
    threading.Timer(0.8, cancel.set).start()
    t = time.monotonic()
    res = run("test-busy-loop@0", RunLimits(event_timeout_ms=30000, total_timeout_ms=60000), cancel=cancel)
    assert res.outcome == "cancelled"
    assert time.monotonic() - t < 6


def test_children_are_cleaned_up_after_failure_and_success():
    pids = []
    for adapter in ("test-busy-loop@0", "ref-purchasing-agent@1.0.0", "test-crash@0"):
        res, child = run_sequence(backend=ProcessBackend(), adapter_key=adapter, config={}, initial_state=default_world(),
                                  actions=REQ, limits=RunLimits(event_timeout_ms=1500, total_timeout_ms=3000))
        if child is not None:
            pids.append(child.proc.pid)
            child.close()
        time.sleep(0.2)
    for pid in pids:
        assert pid_gone(pid)


def test_unknown_isolation_and_disabled_isolation_fail_closed(monkeypatch):
    with pytest.raises(IsolationUnavailable):
        select_backend("vm")
    monkeypatch.setenv("COUNTERPROOF_DISABLE_ISOLATION", "1")
    with pytest.raises(IsolationUnavailable):
        select_backend("process")


def test_unhosted_adapter_cannot_be_loaded():
    res = run("ref-purchasing-agent@9.9.9")
    assert res.outcome == "runner_failure"
