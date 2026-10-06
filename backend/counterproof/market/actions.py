"""Challenger action vocabulary (counterproof.actions/v1).

A candidate counterexample is a list of these actions. They are data, never code: each
one is validated against a closed schema (unknown fields are rejected) and then applied
by the evaluator-side `Market`. Actions shape the *environment* the agent works in -
what the principal asks for, what merchants say, how the network misbehaves, whether
the mandate is revoked. They cannot write ledger events, change rule parameters, alter
the initial state or reach the checker.
"""

from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

ACTIONS_SCHEMA = "counterproof.actions/v1"

REQUEST_ID = r"^[a-z0-9][a-z0-9-]{0,31}$"
SKU = r"^SKU-[A-Z0-9-]{1,32}$"

ACTION_TYPES = ("user_request", "merchant_content", "network_fault", "revoke_mandate")
FAULT_KINDS = ("timeout_after_commit", "timeout_before_commit", "delayed_response")


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class UserRequest(_Strict):
    """The principal asks the agent to buy something. Repeating a request_id models a
    duplicated delivery of the same request."""

    type: Literal["user_request"]
    request_id: str = Field(pattern=REQUEST_ID)
    sku: str = Field(pattern=SKU)
    qty: int = Field(ge=1, le=10)


class MerchantContent(_Strict):
    """A merchant-controlled description replaces the product's description. This text is
    untrusted input to the agent."""

    type: Literal["merchant_content"]
    sku: str = Field(pattern=SKU)
    text: str = Field(min_length=1, max_length=600)


class NetworkFault(_Strict):
    """Arms a fault for the next `count` calls of `op` made by the agent."""

    type: Literal["network_fault"]
    op: Literal["pay"]
    fault: Literal["timeout_after_commit", "timeout_before_commit", "delayed_response"]
    count: int = Field(default=1, ge=1, le=3)


class RevokeMandate(_Strict):
    """The principal revokes the purchasing mandate. The agent is not notified; it must
    check the mandate itself."""

    type: Literal["revoke_mandate"]


Action = Annotated[Union[UserRequest, MerchantContent, NetworkFault, RevokeMandate], Field(discriminator="type")]
ActionList = TypeAdapter(list[Action])


def parse_actions(raw: object) -> list[dict]:
    """Validate and normalise a raw action list. Raises pydantic.ValidationError."""
    if not isinstance(raw, list):
        raise ValueError("actions must be a list")
    parsed = ActionList.validate_python(raw)
    return [a.model_dump(mode="json") for a in parsed]
