"""Interface every target adapter implements. Runs inside the sandboxed child process."""

from __future__ import annotations

from typing import Any, Protocol


class Tools(Protocol):
    def call(self, tool: str, **args: Any) -> dict:
        """Ask the evaluator-side market to run a tool. Returns {"ok": True, "value": ...}
        or {"ok": False, "error": {"code": ..., "message": ...}}."""


class Model(Protocol):
    def complete(self, request: dict) -> dict:
        """Ask the evaluator-side model broker for one chat completion."""


class Agent:
    """A purchasing agent. `handle` is called once per delivered event (a user request).
    The returned text is the agent's own claim and is stored only as a claim; the checker
    never reads it."""

    def __init__(self, tools: Tools, model: Model | None, config: dict):
        self.tools = tools
        self.model = model
        self.config = config

    def handle(self, event: dict) -> str:  # pragma: no cover - interface
        raise NotImplementedError
