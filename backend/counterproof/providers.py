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
MAX_RETRIES = 2


class MissingCredential(Exception):
    pass


class ProviderError(Exception):
    pass


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
        for attempt in range(MAX_RETRIES + 1):
            try:
                r = httpx.post(url, json=body, timeout=TIMEOUT_S,
                               headers={"Authorization": f"Bearer {self._key}", "Content-Type": "application/json"})
            except httpx.HTTPError as e:
                last = f"network error: {type(e).__name__}"
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
                if r.status_code in (400, 401, 403, 404):
                    break
                if r.status_code == 429 or r.status_code >= 500:
                    wait = min(float(r.headers.get("retry-after") or 2 * (attempt + 1)), 20.0)
                    time.sleep(wait)
                    continue
                break
            time.sleep(1.5 * (attempt + 1))
        self.errors.append(last)
        raise ProviderError(f"{self.provider}/{self.model} failed after {attempt + 1} attempt(s): {last}")


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
            raise BrokerRefused("model call budget exhausted")
        if self.max_tokens and self.used_tokens >= self.max_tokens:
            raise BrokerRefused("model token budget exhausted")
        msgs = request.get("messages")
        if not isinstance(msgs, list) or not msgs:
            raise BrokerRefused("request needs messages")
        try:
            return self.client.chat(msgs, tools=request.get("tools"), temperature=self.temperature,
                                    max_tokens=int(request.get("max_tokens") or 600))
        except ProviderError as e:
            raise BrokerRefused(str(e)) from e


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
