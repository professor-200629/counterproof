"""ERC-8004 (Trustless Agents) link: agent identity and reputation from verified results.

What this adds, and what it does not:

* The PUBLISHER registers its agent in the official ERC-8004 IdentityRegistry. The agent's
  registration file (stored on chain as a data: URI) declares the exact CounterProof target it
  runs: adapter key and artifact digest. The binding is the owner's own declaration.
* After a challenge is SETTLED on CounterProofBounties, a dedicated REPORTER key posts one
  feedback entry to the official ReputationRegistry: tag1 ``counterproof.verifiedViolation``,
  tag2 the rule id, value 1. The feedback file (also a data: URI, keccak-hashed) carries the
  challenge, spec digest, settled submission, evidence digest and settle transaction, so anyone
  can check it against the chain. The reporter refuses unless the chain shows the settlement and
  the agent's declared digest equals the funded spec's target digest.
* A refunded challenge where nothing was found may be reported with tag1
  ``counterproof.noViolationFound`` and value = sequences tested. That is a search count, not a
  safety score.

Feedback is an attestation by a declared reviewer (the reporter address), as ERC-8004 intends:
readers choose which clientAddresses they trust. It is not a proof that an AI is correct.

Official registries (github.com/erc-8004/erc-8004-contracts README at commit b9e466c, read
2026-10-11; contract code present at both addresses checked with eth_getCode the same day).
"""

from __future__ import annotations

import base64
import json
import time
from typing import Any

from .canonical import canonical_json

REGISTRIES = {
    10143: {  # Monad Testnet
        "identity": "0x8004A818BFB912233c491871b3d84c89A494BD9e",
        "reputation": "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    },
}
REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1"
TAG_VIOLATION = "counterproof.verifiedViolation"
TAG_NO_VIOLATION = "counterproof.noViolationFound"
MAX_URI_BYTES = 16_384

IDENTITY_ABI = [
    {"type": "function", "name": "register", "stateMutability": "nonpayable",
     "inputs": [{"name": "agentURI", "type": "string"}], "outputs": [{"name": "agentId", "type": "uint256"}]},
    {"type": "function", "name": "tokenURI", "stateMutability": "view",
     "inputs": [{"name": "tokenId", "type": "uint256"}], "outputs": [{"name": "", "type": "string"}]},
    {"type": "function", "name": "ownerOf", "stateMutability": "view",
     "inputs": [{"name": "tokenId", "type": "uint256"}], "outputs": [{"name": "", "type": "address"}]},
    {"type": "function", "name": "isAuthorizedOrOwner", "stateMutability": "view",
     "inputs": [{"name": "spender", "type": "address"}, {"name": "agentId", "type": "uint256"}],
     "outputs": [{"name": "", "type": "bool"}]},
    {"type": "event", "name": "Registered", "anonymous": False,
     "inputs": [{"name": "agentId", "type": "uint256", "indexed": True},
                {"name": "agentURI", "type": "string", "indexed": False},
                {"name": "owner", "type": "address", "indexed": True}]},
]
REPUTATION_ABI = [
    {"type": "function", "name": "giveFeedback", "stateMutability": "nonpayable",
     "inputs": [{"name": "agentId", "type": "uint256"}, {"name": "value", "type": "int128"},
                {"name": "valueDecimals", "type": "uint8"}, {"name": "tag1", "type": "string"},
                {"name": "tag2", "type": "string"}, {"name": "endpoint", "type": "string"},
                {"name": "feedbackURI", "type": "string"}, {"name": "feedbackHash", "type": "bytes32"}],
     "outputs": []},
    {"type": "function", "name": "readFeedback", "stateMutability": "view",
     "inputs": [{"name": "agentId", "type": "uint256"}, {"name": "clientAddress", "type": "address"},
                {"name": "feedbackIndex", "type": "uint64"}],
     "outputs": [{"name": "value", "type": "int128"}, {"name": "valueDecimals", "type": "uint8"},
                 {"name": "tag1", "type": "string"}, {"name": "tag2", "type": "string"},
                 {"name": "isRevoked", "type": "bool"}]},
    {"type": "function", "name": "getSummary", "stateMutability": "view",
     "inputs": [{"name": "agentId", "type": "uint256"}, {"name": "clientAddresses", "type": "address[]"},
                {"name": "tag1", "type": "string"}, {"name": "tag2", "type": "string"}],
     "outputs": [{"name": "count", "type": "uint64"}, {"name": "summaryValue", "type": "int128"},
                 {"name": "summaryValueDecimals", "type": "uint8"}]},
    {"type": "event", "name": "NewFeedback", "anonymous": False,
     "inputs": [{"name": "agentId", "type": "uint256", "indexed": True},
                {"name": "clientAddress", "type": "address", "indexed": True},
                {"name": "feedbackIndex", "type": "uint64", "indexed": False},
                {"name": "value", "type": "int128", "indexed": False},
                {"name": "valueDecimals", "type": "uint8", "indexed": False},
                {"name": "indexedTag1", "type": "string", "indexed": True},
                {"name": "tag1", "type": "string", "indexed": False},
                {"name": "tag2", "type": "string", "indexed": False},
                {"name": "endpoint", "type": "string", "indexed": False},
                {"name": "feedbackURI", "type": "string", "indexed": False},
                {"name": "feedbackHash", "type": "bytes32", "indexed": False}]},
]


class Erc8004Error(Exception):
    """A check failed; nothing was (or should be) sent."""


def registries(chain_id: int) -> dict:
    r = REGISTRIES.get(int(chain_id))
    if not r:
        raise Erc8004Error(f"no official ERC-8004 registries recorded for chain {chain_id}")
    return r


def caip10(chain_id: int, address: str) -> str:
    return f"eip155:{int(chain_id)}:{address}"


# ----------------------------------------------------------------------------- files
def data_uri(obj: dict) -> str:
    """Canonical JSON as a base64 data: URI (fully on-chain, as ERC-8004 allows)."""
    return "data:application/json;base64," + base64.b64encode(canonical_json(obj)).decode("ascii")


def parse_data_uri(uri: str) -> dict:
    prefix = "data:application/json;base64,"
    if not isinstance(uri, str) or not uri.startswith(prefix):
        raise Erc8004Error("agentURI is not a data:application/json;base64 URI; the binding cannot be checked offline")
    if len(uri) > MAX_URI_BYTES:
        raise Erc8004Error("agentURI too large")
    try:
        return json.loads(base64.b64decode(uri[len(prefix):], validate=True))
    except Exception as e:
        raise Erc8004Error(f"agentURI is not valid base64 JSON: {e}") from e


def keccak_hex(data: bytes) -> str:
    from eth_utils import keccak

    return "0x" + keccak(data).hex()


def registration_file(*, target_key: str, artifact_digest: str, name: str, description: str,
                      web_url: str | None = None) -> dict:
    """The agent registration file (registration-v1) with CounterProof's target binding."""
    reg: dict[str, Any] = {
        "type": REGISTRATION_TYPE,
        "name": name,
        "description": description,
        "services": [{"name": "web", "endpoint": web_url}] if web_url else [],
        "active": True,
        "supportedTrust": ["reputation"],
        "counterproof": {"target": target_key, "artifactDigest": artifact_digest},
    }
    return reg


def declared_target(registration: dict) -> tuple[str, str]:
    cp = registration.get("counterproof") if isinstance(registration, dict) else None
    if registration.get("type") != REGISTRATION_TYPE or not isinstance(cp, dict):
        raise Erc8004Error("registration file has no counterproof target declaration")
    target, digest = cp.get("target"), cp.get("artifactDigest")
    if not isinstance(target, str) or not isinstance(digest, str):
        raise Erc8004Error("registration file has a malformed counterproof target declaration")
    return target, digest


def violation_feedback_file(*, chain_id: int, agent_id: int, reporter: str, bounties: str, onchain_id: int,
                            spec_digest: str, target_key: str, artifact_digest: str, rule_id: str,
                            submission_id: str, evidence_digest: str, settle_tx: str, endpoint: str | None,
                            created_at: int | None = None) -> dict:
    ts = int(created_at if created_at is not None else time.time())
    return {
        "agentRegistry": caip10(chain_id, registries(chain_id)["identity"]),
        "agentId": int(agent_id),
        "clientAddress": caip10(chain_id, reporter),
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts)),
        "value": 1,
        "valueDecimals": 0,
        "tag1": TAG_VIOLATION,
        "tag2": rule_id,
        **({"endpoint": endpoint} if endpoint else {}),
        "counterproof": {
            "meaning": ("One target version, given one exact action sequence, broke one agreed rule in the "
                        "evaluator's replays. Attested by a declared evaluator; not a zero-knowledge proof."),
            "bounties": caip10(chain_id, bounties),
            "challengeId": int(onchain_id),
            "specDigest": spec_digest,
            "target": target_key,
            "artifactDigest": artifact_digest,
            "rule": rule_id,
            "submissionId": submission_id,
            "evidenceDigest": evidence_digest,
            "settleTx": settle_tx,
        },
    }


# ----------------------------------------------------------------------------- chain checks
def identity(w3):
    return w3.eth.contract(address=w3.to_checksum_address(registries(w3.eth.chain_id)["identity"]), abi=IDENTITY_ABI)


def reputation(w3):
    return w3.eth.contract(address=w3.to_checksum_address(registries(w3.eth.chain_id)["reputation"]), abi=REPUTATION_ABI)


def read_agent(w3, agent_id: int) -> dict:
    ident = identity(w3)
    try:
        owner = ident.functions.ownerOf(int(agent_id)).call()
        uri = ident.functions.tokenURI(int(agent_id)).call()
    except Exception as e:
        raise Erc8004Error(f"agent {agent_id} is not registered: {type(e).__name__}") from e
    reg = parse_data_uri(uri)
    target, digest = declared_target(reg)
    return {"agent_id": int(agent_id), "owner": owner, "registration": reg, "target": target, "artifact_digest": digest}


def registered_agent_id(w3, receipt) -> int:
    from web3.logs import DISCARD

    events = identity(w3).events.Registered().process_receipt(receipt, errors=DISCARD)
    if len(events) != 1:
        raise Erc8004Error(f"expected one Registered event, found {len(events)}")
    return int(events[0]["args"]["agentId"])


def check_violation_report(w3, *, bounties_contract, onchain_id: int, settle_tx: str, spec: dict, spec_digest: str,
                           evidence: dict, agent_id: int, reporter: str) -> dict:
    """Every fact the feedback states, checked against the chain and the sealed evidence.
    Returns the fields for violation_feedback_file; raises Erc8004Error on any mismatch."""
    from .canonical import from_bytes32

    ch = bounties_contract.functions.getChallenge(int(onchain_id)).call()
    status, chain_spec, settled_sub = int(ch[4]), from_bytes32(ch[6]), "0x" + bytes(ch[7]).hex()
    if status != 2:
        raise Erc8004Error(f"challenge {onchain_id} is not settled on chain (status {status})")
    if chain_spec != spec_digest:
        raise Erc8004Error("on-chain spec digest differs from the spec being reported")

    rcpt = w3.eth.get_transaction_receipt(settle_tx)
    if rcpt.status != 1 or (rcpt["to"] or "").lower() != bounties_contract.address.lower():
        raise Erc8004Error("settle transaction did not succeed on the bounties contract")
    settled = [e for e in bounties_contract.events.ChallengeSettled().process_receipt(rcpt)
               if int(e["args"]["challengeId"]) == int(onchain_id)]
    if len(settled) != 1:
        raise Erc8004Error("settle transaction has no ChallengeSettled event for this challenge")
    ev_args = settled[0]["args"]
    submission_id = "0x" + bytes(ev_args["submissionId"]).hex()
    evidence_digest = from_bytes32(ev_args["evidenceDigest"])
    if submission_id != settled_sub:
        raise Erc8004Error("ChallengeSettled submission differs from the challenge's settled submission")

    from .evaluator import recheck_bundle

    if evidence.get("evidence_digest") != evidence_digest:
        raise Erc8004Error("evidence bundle is not the one named in ChallengeSettled")
    problems = recheck_bundle(evidence, spec)
    if problems:
        raise Erc8004Error("evidence bundle fails re-verification: " + "; ".join(problems))
    verdict = evidence.get("verdict") or {}
    if verdict.get("outcome") != "verified_violation":
        raise Erc8004Error(f"evidence outcome is {verdict.get('outcome')!r}, not verified_violation")
    rule_id = evidence.get("claimed_rule")
    if not isinstance(rule_id, str) or not any(r.get("id") == rule_id for r in spec.get("rules", [])):
        raise Erc8004Error("evidence rule is not one of the spec's rules")

    agent = read_agent(w3, agent_id)
    target_key = f"{spec['target']['adapter']}@{spec['target']['version']}"
    if agent["artifact_digest"] != spec["target"]["artifact_digest"]:
        raise Erc8004Error(f"agent {agent_id} declares artifact {agent['artifact_digest']}, the spec funded "
                           f"{spec['target']['artifact_digest']}; refusing to attach this result to it")
    if identity(w3).functions.isAuthorizedOrOwner(w3.to_checksum_address(reporter), int(agent_id)).call():
        raise Erc8004Error("the reporter owns or operates this agent; ERC-8004 forbids self-feedback")
    return {"chain_id": w3.eth.chain_id, "agent_id": int(agent_id), "reporter": w3.to_checksum_address(reporter),
            "bounties": bounties_contract.address, "onchain_id": int(onchain_id), "spec_digest": spec_digest,
            "target_key": target_key, "artifact_digest": agent["artifact_digest"], "rule_id": rule_id,
            "submission_id": submission_id, "evidence_digest": evidence_digest, "settle_tx": settle_tx}


def give_feedback_args(file: dict) -> tuple[list, str]:
    """(giveFeedback args, feedbackURI) for a feedback file; feedbackHash = keccak256 of the URI's bytes."""
    uri = data_uri(file)
    payload = canonical_json(file)
    return ([int(file["agentId"]), int(file["value"]), int(file["valueDecimals"]), file["tag1"], file.get("tag2", ""),
             file.get("endpoint", ""), uri, bytes.fromhex(keccak_hex(payload)[2:])], uri)
