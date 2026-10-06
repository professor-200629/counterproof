"""Provider client behaviour (mocked HTTP) and how the session classifies model failures."""

import time

import httpx
import pytest
from conftest import BUDGET_ATTACK, make_candidate, make_spec

from counterproof import providers
from counterproof.evaluator import evaluate
from counterproof.runner.session import BrokerRefused

OK_BODY = {"model": "m", "choices": [{"message": {"content": "hi", "tool_calls": []}, "finish_reason": "stop"}],
           "usage": {"prompt_tokens": 3, "completion_tokens": 2}}


class Resp:
    def __init__(self, status, body=None, text="", headers=None):
        self.status_code = status
        self._body = body
        self.text = text or (str(body) if body else "")
        self.headers = headers or {}

    def json(self):
        return self._body


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_" + "k" * 40)
    monkeypatch.setenv("COUNTERPROOF_LLM_TPM", "1000000")
    sleeps = []
    monkeypatch.setattr(providers.time, "sleep", lambda s: sleeps.append(s))
    c = providers.ChatClient("groq", "openai/gpt-oss-20b")
    c._sleeps = sleeps
    return c


def script(monkeypatch, responses):
    seq = list(responses)

    def post(*a, **k):
        r = seq.pop(0)
        if isinstance(r, Exception):
            raise r
        return r

    monkeypatch.setattr(providers.httpx, "post", post)


def test_rate_limit_waits_as_asked_then_succeeds(client, monkeypatch):
    script(monkeypatch, [Resp(429, text='{"error":{"message":"Rate limit reached... Please try again in 1.5s"}}'),
                         Resp(429, headers={"retry-after": "3"}), Resp(200, OK_BODY)])
    out = client.chat([{"role": "user", "content": "x"}])
    assert out["message"]["content"] == "hi"
    assert client._sleeps[:2] == [2.0, 3.5]
    assert client.rate_limited_seconds == pytest.approx(5.5)


def test_invalid_tool_calls_become_model_output_failures(client, monkeypatch):
    bad = Resp(400, text='{"error":{"message":"Tool call validation failed","code":"tool_use_failed"}}')
    script(monkeypatch, [bad, bad, bad])
    with pytest.raises(providers.ProviderError) as e:
        client.chat([{"role": "user", "content": "x"}])
    assert e.value.kind == "model_output"


def test_network_errors_are_unavailable(client, monkeypatch):
    script(monkeypatch, [httpx.ConnectError("down")] * (providers.MAX_RETRIES + 1))
    with pytest.raises(providers.ProviderError) as e:
        client.chat([{"role": "user", "content": "x"}])
    assert e.value.kind == "unavailable"


def test_auth_errors_are_not_retried(client, monkeypatch):
    script(monkeypatch, [Resp(401, text="invalid api key gsk_" + "k" * 40)])
    with pytest.raises(providers.ProviderError) as e:
        client.chat([{"role": "user", "content": "x"}])
    assert "gsk_" not in str(e.value)  # redacted


def test_shared_pacer_spaces_requests_across_processes(tmp_path, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(providers.time, "time", lambda: clock[0])
    slept = []

    def fake_sleep(s):
        slept.append(s)
        clock[0] += s

    a = providers.SharedPacer(tmp_path / "rl.sqlite")
    b = providers.SharedPacer(tmp_path / "rl.sqlite")  # a second worker process sees the same window
    assert a.wait("k", 8000, 5000, sleep=fake_sleep) == 0
    assert b.wait("k", 8000, 2000, sleep=fake_sleep) == 0
    waited = b.wait("k", 8000, 3000, sleep=fake_sleep)  # 10,000 > 8,000 within the minute
    assert waited > 59 and slept
    assert a.wait("other-model", 8000, 7000, sleep=fake_sleep) == 0  # separate budget per model


def test_cancel_interrupts_a_rate_limit_wait(client, monkeypatch):
    import threading

    script(monkeypatch, [Resp(429, headers={"retry-after": "60"})] * 3)
    client.cancel = threading.Event()
    client.cancel.set()
    with pytest.raises(providers.ProviderError) as e:
        client.chat([{"role": "user", "content": "x"}])
    assert e.value.kind == "cancelled"


LLM = "llm-purchasing-agent@0.1.1"


def run_eval(broker):
    spec, d = make_spec(LLM, target_config={"provider": "groq", "model": "s", "temperature": 0, "max_steps": 8})
    return evaluate(spec=spec, spec_dgst=d, candidate=make_candidate(d, BUDGET_ATTACK, "R1"), submission={}, broker=broker)


def test_invalid_model_output_is_a_target_failure():
    def broker(_r):
        raise BrokerRefused("tool call validation failed", kind="model_output")

    b = run_eval(broker)
    assert b["verdict"]["outcome"] == "target_crash"
    assert "invalid" in b["replays"][0]["run_reason"]


def test_provider_wait_does_not_count_against_the_target(monkeypatch):
    calls = {"n": 0}

    def slow(request):
        calls["n"] += 1
        time.sleep(1.2)  # longer than the event limit below
        return {"model": "s", "message": {"content": "nothing to do", "tool_calls": []}, "usage": {}}

    spec, d = make_spec(LLM, target_config={"provider": "groq", "model": "s", "temperature": 0, "max_steps": 8},
                        limits={"event_timeout_ms": 1000, "total_timeout_ms": 1500})
    b = evaluate(spec=spec, spec_dgst=d, candidate=make_candidate(d, BUDGET_ATTACK, "R1"), submission={}, broker=slow)
    assert all(r["run_outcome"] == "completed" for r in b["replays"]), [r["run_reason"] for r in b["replays"]]
    assert b["replays"][0]["stats"]["model_wait_ms"] >= 2000
