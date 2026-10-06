"""Model providers (OpenAI-compatible chat completions) and the evaluator-side model broker.

Live-model mode is optional. Deterministic mode needs no model at all. When a live model is
required and not configured, callers get `MissingCredential` with an explicit message -
never a silent fallback to fixtures.

Supported providers (only those whose key is present are usable):
  groq        GROQ_API_KEY        https://api.groq.com/openai/v1
  openai      OPENAI_API_KEY      https://api.openai.com/v1
  openrouter  OPENROUTER_API_KEY  https://openrouter.ai/api/v1

Keys are read only in the evaluator/worker process. Target sandboxes never receive them:
targets ask the broker (over the runner protocol) and the broker makes the HTTP call.
"""

from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import dataclass, field

import httpx

from .redact import redact
from .runner.session import BrokerRefused

PROVIDERS = {
    "groq": {"base": "https://api.groq.com/openai/v1", "key_env": "GROQ_API_KEY", "default_model": "openai/gpt-oss-20b"},
    "openai": {"base": "https://api.openai.com/v1", "key_env": "OPENAI_API_KEY", "default_model": "gpt-4o-mini"},
    "openrouter": {"base": "https://openrouter.ai/api/v1", "key_env": "OPENROUTER_API_KEY", "default_model": "openai/gpt-oss-20b:free"},
}
MAX_COMPLETION_TOKENS = 900
TIMEOUT_S = 60
MAX_RETRIES = 5            # network errors and 5xx (backoff 2, 4, 8, 16, 30 s)
MAX_RATE_LIMIT_WAITS = 8   # 429s: wait as long as the provider asks (capped), then retry
MAX_RATE_LIMIT_SLEEP = 65.0
MAX_GENERATION_RETRIES = 2  # 400 "tool call validation failed": the model's output was invalid
# Per-minute token limit used for client-side pacing (Groq free tier: 8,000 TPM per model,
# read from x-ratelimit-limit-tokens on 2026-10-06). Groq counts max_tokens as reserved.
DEFAULT_TPM = {"groq": 8000}


class MissingCredential(Exception):
    pass


class ProviderError(Exception):
    """kind: "unavailable" (network, 5xx, auth, rate limit not cleared) or "model_output"
    (the provider rejected what the model generated, e.g. an invalid tool call)."""

    def __init__(self, message: str, kind: str = "unavailable"):
        super().__init__(message)
        self.kind = kind


class SharedPacer:
    """Sliding 60-second token window per provider/model, shared by every worker process
    through a small SQLite file (the provider's limit is per account, not per process)."""

    def __init__(self, path=None) -> None:
        self.path = path

    def _db(self):
        import sqlite3

        from .config import settings

        p = self.path or (settings().data_dir / "ratelimit.sqlite")
        p.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(p, timeout=30, isolation_level=None)
        conn.execute("CREATE TABLE IF NOT EXISTS usage (key TEXT, t REAL, tokens INTEGER)")
        return conn

    def wait(self, key: str, tpm: int, tokens: int, sleep=time.sleep) -> float:
        waited = 0.0
        conn = self._db()
        try:
            while True:
                now = time.time()
                conn.execute("BEGIN IMMEDIATE")
                conn.execute("DELETE FROM usage WHERE t < ?", (now - 60,))
                rows = conn.execute("SELECT t, tokens FROM usage WHERE key=? ORDER BY t", (key,)).fetchall()
                used = sum(n for _, n in rows)
                if used + tokens <= tpm or not rows:
                    conn.execute("INSERT INTO usage VALUES (?,?,?)", (key, now, tokens))
                    conn.execute("COMMIT")
                    return waited
                conn.execute("COMMIT")
                pause = max(0.25, 60 - (now - rows[0][0]) + 0.25)
                sleep(pause)
                waited += pause
        finally:
            conn.close()


PACER = SharedPacer()


def _retry_after(r) -> float:
    import re as _re

    h = r.headers.get("retry-after")
    if h:
        try:
            return float(h)
        except ValueError:
            pass
    m = _re.search(r"try again in ([0-9.]+)(ms|s)", r.text)
    if m:
        v = float(m.group(1))
        return v / 1000 if m.group(2) == "ms" else v
    return 5.0


def provider_status() -> list[dict]:
    """Which provider keys are present - presence only, never the key. Presence does not
    mean the account has quota; a live run reports the provider's real answer."""
    return [{"provider": p, "key_env": c["key_env"], "configured": bool(os.environ.get(c["key_env"])),
             "key_present": bool(os.environ.get(c["key_env"])), "availability": "not checked",
             "default_model": c["default_model"]} for p, c in PROVIDERS.items()]


@dataclass
class ChatClient:
    provider: str
    model: str
    calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    errors: list[str] = field(default_factory=list)
    paced_seconds: float = 0.0
    rate_limited_seconds: float = 0.0
    cancel: threading.Event | None = None  # set by the worker; waits end early when it fires

    def _sleep(self, seconds: float) -> None:
        if self.cancel is not None:
            if self.cancel.wait(seconds):
                raise ProviderError("cancelled while waiting for the provider", kind="cancelled")
        else:
            time.sleep(seconds)

    def __post_init__(self) -> None:
        if self.provider not in PROVIDERS:
            raise MissingCredential(f"unknown provider {self.provider!r}; choose one of {sorted(PROVIDERS)}")
        self._key = os.environ.get(PROVIDERS[self.provider]["key_env"])
        if not self._key:
            raise MissingCredential(f"{PROVIDERS[self.provider]['key_env']} is not set; live-model mode with "
                                    f"{self.provider} is unavailable. Deterministic mode still works.")
        self._lock = threading.Lock()

    def chat(self, messages: list[dict], tools: list[dict] | None = None, temperature: float = 0.0,
             max_tokens: int = 600, response_format: dict | None = None) -> dict:
        body: dict = {"model": self.model, "messages": messages, "temperature": temperature,
                      "max_tokens": min(max_tokens, MAX_COMPLETION_TOKENS)}
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        if response_format:
            body["response_format"] = response_format
        if self.provider == "groq" and self.model.startswith("openai/gpt-oss"):
            body["reasoning_effort"] = "low"
        url = PROVIDERS[self.provider]["base"] + "/chat/completions"
        last = ""
        kind = "unavailable"
        tpm = int(os.environ.get("COUNTERPROOF_LLM_TPM") or DEFAULT_TPM.get(self.provider, 0))
        estimate = len(json.dumps(body)) // 4 + body["max_tokens"]  # ~4 characters per token
        attempt, failures, rate_waits, gen_retries = 0, 0, 0, 0
        while True:
            attempt += 1
            if self.cancel is not None and self.cancel.is_set():
                raise ProviderError("cancelled", kind="cancelled")
            if tpm:
                self.paced_seconds += PACER.wait(f"{self.provider}/{self.model}", tpm, estimate, sleep=self._sleep)
            try:
                r = httpx.post(url, json=body, timeout=TIMEOUT_S,
                               headers={"Authorization": f"Bearer {self._key}", "Content-Type": "application/json"})
            except httpx.HTTPError as e:
                last = f"network error: {type(e).__name__}"
                failures += 1
                if failures > MAX_RETRIES:
                    break
                self._sleep(min(2.0 ** failures, 30.0))
                continue
            else:
                if r.status_code == 200:
                    data = r.json()
                    usage = data.get("usage") or {}
                    with self._lock:
                        self.calls += 1
                        self.prompt_tokens += int(usage.get("prompt_tokens") or 0)
                        self.completion_tokens += int(usage.get("completion_tokens") or 0)
                    choice = (data.get("choices") or [{}])[0]
                    msg = choice.get("message") or {}
                    return {"model": data.get("model", self.model), "finish_reason": choice.get("finish_reason"),
                            "message": {"role": "assistant", "content": msg.get("content"),
                                        "tool_calls": msg.get("tool_calls") or []},
                            "usage": {"prompt_tokens": int(usage.get("prompt_tokens") or 0),
                                      "completion_tokens": int(usage.get("completion_tokens") or 0)}}
                last = f"HTTP {r.status_code}: {redact(r.text[:300])}"
                if r.status_code == 429:
                    rate_waits += 1
                    if rate_waits > MAX_RATE_LIMIT_WAITS:
                        break
                    pause = min(_retry_after(r) + 0.5, MAX_RATE_LIMIT_SLEEP)
                    self.rate_limited_seconds += pause
                    self._sleep(pause)
                    continue
                if r.status_code == 400 and any(s in r.text for s in ("tool_use_failed", "Tool call validation failed",
                                                                      "Parsing failed", "failed_generation")):
                    gen_retries += 1
                    if gen_retries > MAX_GENERATION_RETRIES:
                        kind = "model_output"
                        break
                    continue
                if r.status_code >= 500:
                    failures += 1
                    if failures > MAX_RETRIES:
                        break
                    self._sleep(2.0 * failures)
                    continue
                break
        self.errors.append(last)
        raise ProviderError(f"{self.provider}/{self.model} failed after {attempt} attempt(s): {last}", kind=kind)


class ModelBroker:
    """Callable handed to the runner session. The model, temperature ceiling and token
    budget come from the challenge spec, not from the target."""

    def __init__(self, client: ChatClient, max_calls: int, max_tokens: int, temperature: float):
        self.client = client
        self.max_calls = max_calls
        self.max_tokens = max_tokens
        self.temperature = temperature

    @property
    def used_tokens(self) -> int:
        return self.client.prompt_tokens + self.client.completion_tokens

    def __call__(self, request: dict) -> dict:
        if self.client.calls >= self.max_calls:
            raise BrokerRefused("model call budget exhausted", kind="budget")
        if self.max_tokens and self.used_tokens >= self.max_tokens:
            raise BrokerRefused("model token budget exhausted", kind="budget")
        msgs = request.get("messages")
        if not isinstance(msgs, list) or not msgs:
            raise BrokerRefused("request needs messages", kind="request")
        try:
            return self.client.chat(msgs, tools=request.get("tools"), temperature=self.temperature,
                                    max_tokens=int(request.get("max_tokens") or 600))
        except ProviderError as e:
            kind = {"model_output": "model_output", "cancelled": "cancelled"}.get(e.kind, "provider")
            raise BrokerRefused(str(e), kind=kind) from e


def broker_for_spec(spec: dict, budget) -> ModelBroker | None:
    """A broker for targets that need a model; None for deterministic targets."""
    cfg = spec["target"].get("config") or {}
    if spec["target"]["determinism"] != "stochastic" or not cfg.get("provider"):
        return None
    client = ChatClient(cfg["provider"], cfg.get("model") or PROVIDERS[cfg["provider"]]["default_model"])
    limits = spec["limits"]
    return ModelBroker(client, max_calls=limits["max_model_calls"] * spec["reproducibility"]["replays"] * 20,
                       max_tokens=limits["max_model_tokens"] * 20, temperature=float(cfg.get("temperature", 0)))


def provenance_for(spec: dict, run: dict, broker: ModelBroker | None) -> dict:
    p = {"strategy": run["strategy"], "mode": run["mode"], "target_determinism": spec["target"]["determinism"],
         "inference": "none (deterministic)"}
    if broker is not None:
        p.update({"inference": "live", "target_model": f"{broker.client.provider}/{broker.client.model}",
                  "target_model_calls": broker.client.calls, "target_model_tokens": broker.used_tokens,
                  "provider_errors": broker.client.errors[-3:]})
    return p
