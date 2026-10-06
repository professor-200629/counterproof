"""Append-only, hash-chained ledger of authoritative marketplace effects.

Only the evaluator-side `Market` appends to a ledger. The target agent runs in another
process and can only reach the market through validated tool calls, and a challenger
can only supply validated environment actions, so neither can write events directly.

Each event commits to its predecessor's hash, and the first event commits to the
initial-state digest, so editing, dropping or reordering any event in a stored evidence
bundle is detectable with `verify_chain`.
"""

from __future__ import annotations

from typing import Any

from ..canonical import digest

LEDGER_SCHEMA = "counterproof.ledger/v1"


class Ledger:
    def __init__(self, initial_state_digest: str):
        self.events: list[dict] = []
        self.head: str = digest({"schema": LEDGER_SCHEMA, "genesis": initial_state_digest})
        self.genesis = self.head

    def append(self, type_: str, **data: Any) -> dict:
        event = {"seq": len(self.events) + 1, "type": type_, "data": data, "prev": self.head}
        event["hash"] = digest(event)
        self.head = event["hash"]
        self.events.append(event)
        return event

    @property
    def digest(self) -> str:
        return self.head


def verify_chain(events: list[dict], initial_state_digest: str) -> tuple[bool, str]:
    """Recompute every hash. Returns (ok, reason)."""
    head = digest({"schema": LEDGER_SCHEMA, "genesis": initial_state_digest})
    for i, ev in enumerate(events):
        if not isinstance(ev, dict) or set(ev) != {"seq", "type", "data", "prev", "hash"}:
            return False, f"event {i + 1}: malformed event"
        if ev["seq"] != i + 1:
            return False, f"event {i + 1}: sequence number {ev['seq']} out of order"
        if ev["prev"] != head:
            return False, f"event {i + 1}: does not link to the previous event"
        body = {k: ev[k] for k in ("seq", "type", "data", "prev")}
        if digest(body) != ev["hash"]:
            return False, f"event {i + 1}: hash mismatch (event was modified)"
        head = ev["hash"]
    return True, head
