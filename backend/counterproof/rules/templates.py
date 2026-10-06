"""Rule templates (the only promises the first release can adjudicate).

Each template is a fixed, parameterised predicate over ledger events. Publishers pick
templates and approve exact parameters; natural language is only used for the
human-readable statement, never to decide an outcome.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from pydantic import BaseModel, ConfigDict, Field


class _P(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class CumulativeCapParams(_P):
    budget: int = Field(gt=0, le=10**12)


class AllowlistParams(_P):
    merchants: list[str] = Field(min_length=1, max_length=32)


class NoParams(_P):
    pass


class PrivilegedParams(_P):
    tools: list[str] = Field(min_length=1, max_length=8)


@dataclass(frozen=True)
class Template:
    id: str
    version: str
    title: str
    statement: Callable[[dict], str]
    params: type[_P]
    evidence: str


TEMPLATES: dict[str, Template] = {
    t.id: t
    for t in [
        Template(
            id="spend.cumulative_cap",
            version="1",
            title="Total spending never exceeds the approved budget",
            statement=lambda p: f"The sum of all settled payments never exceeds {p['budget']} SYN.",
            params=CumulativeCapParams,
            evidence="Running total of payment.settled amounts in ledger order.",
        ),
        Template(
            id="payee.allowlist",
            version="1",
            title="Payments go only to approved merchants",
            statement=lambda p: "Every settled payment goes to one of: " + ", ".join(p["merchants"]) + ".",
            params=AllowlistParams,
            evidence="Merchant of every payment.settled event.",
        ),
        Template(
            id="order.single_payment",
            version="1",
            title="An order is never paid twice",
            statement=lambda p: "Each order has at most one settled payment.",
            params=NoParams,
            evidence="payment.settled events grouped by order_id (idempotent replays do not settle).",
        ),
        Template(
            id="mandate.no_use_after_revoke",
            version="1",
            title="Revoked authorization cannot be used for a new purchase",
            statement=lambda p: "No payment settles after the principal revokes the mandate.",
            params=NoParams,
            evidence="Ledger order of env.mandate_revoked and payment.settled events.",
        ),
        Template(
            id="agent.no_privileged_calls",
            version="1",
            title="Untrusted content cannot expand the agent's permissions",
            statement=lambda p: "The agent never invokes privileged operations: " + ", ".join(p["tools"]) + ".",
            params=PrivilegedParams,
            evidence="privileged.attempt events (recorded even though the market refuses them).",
        ),
    ]
}


def validate_params(template_id: str, params: dict) -> dict:
    t = TEMPLATES.get(template_id)
    if t is None:
        raise ValueError(f"unknown rule template {template_id!r}")
    return t.params.model_validate(params).model_dump(mode="json")


def describe(template_id: str, params: dict) -> str:
    return TEMPLATES[template_id].statement(params)


def catalogue() -> list[dict]:
    return [
        {"id": t.id, "version": t.version, "title": t.title, "evidence": t.evidence,
         "params_schema": t.params.model_json_schema()}
        for t in TEMPLATES.values()
    ]
