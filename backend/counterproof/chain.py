"""Chain access for the API and worker (never holds the evaluator key).

* verifies funding/settlement/refund/withdraw transactions by reading receipts and events
  from the chain - the browser only tells us a hash, never the values;
* commits candidate digests with the challenger bot's key (challenger side, optional);
* asks the separate signer service for an attestation after a verified violation.

Local anvil transactions are labelled as such everywhere; they are never described as
Monad testnet transactions.
"""

from __future__ import annotations

import json
import os
import sqlite3
from functools import lru_cache
from pathlib import Path

import httpx

from .canonical import from_bytes32, to_bytes32
from .config import ROOT, network_label, settings
from .db import dumps, log_activity, now, row, tx
from .redact import redact

ABI_PATHS = [
    ROOT / "contracts" / "out" / "CounterProofBounties.sol" / "CounterProofBounties.json",
    Path(__file__).with_name("abi") / "CounterProofBounties.json",
]
STATUS = {0: "none", 1: "funded", 2: "settled", 3: "refunded"}


class ChainError(Exception):
    pass


@lru_cache
def abi() -> list:
    for p in ABI_PATHS:
        if p.exists():
            data = json.loads(p.read_text(encoding="utf-8"))
            return data["abi"] if isinstance(data, dict) else data
    raise ChainError("contract ABI not found; build contracts/ with forge or run scripts/sync_abi.py")


def w3():
    from web3 import Web3

    s = settings()
    if not s.rpc_url:
        raise ChainError("no RPC configured (COUNTERPROOF_NETWORK=offchain)")
    return Web3(Web3.HTTPProvider(s.rpc_url, request_kwargs={"timeout": 20}))


def contract(address: str | None = None):
    s = settings()
    addr = address or s.contract
    if not addr:
        raise ChainError("COUNTERPROOF_CONTRACT is not set; deploy the contract first")
    web3 = w3()
    return web3, web3.eth.contract(address=web3.to_checksum_address(addr), abi=abi())


def explorer_tx(hash_: str) -> str | None:
    t = settings().explorer_tx_url
    return t.format(hash=hash_) if t else None


def chain_status() -> dict:
    s = settings()
    out = {"network": s.network, "label": network_label(), "chain_id": s.chain_id, "contract": s.contract,
           "rpc": s.rpc_url, "reachable": False, "explorer_tx_url": s.explorer_tx_url}
    if s.network == "offchain":
        return out
    try:
        web3 = w3()
        cid = web3.eth.chain_id
        out.update(reachable=True, rpc_chain_id=cid, block=web3.eth.block_number, chain_id_matches=cid == s.chain_id)
        if s.contract:
            out["contract_has_code"] = len(web3.eth.get_code(web3.to_checksum_address(s.contract))) > 0
    except Exception as e:
        out["error"] = redact(f"{type(e).__name__}: {e}")[:200]
    return out


# --------------------------------------------------------------------------- reads
def read_challenge(onchain_id: int) -> dict:
    _, c = contract()
    ch = c.functions.getChallenge(int(onchain_id)).call()
    publisher, evaluator, sub_deadline, settle_deadline, status, reward, spec_digest, settled = ch
    return {"publisher": publisher.lower(), "evaluator": evaluator.lower(), "submission_deadline": int(sub_deadline),
            "settlement_deadline": int(settle_deadline), "status": STATUS.get(int(status), str(status)),
            "reward_wei": str(reward), "spec_digest": from_bytes32(spec_digest),
            "settled_submission": "0x" + bytes(settled).hex()}


def read_submission(submission_id: str) -> dict | None:
    _, c = contract()
    s = c.functions.getSubmission(bytes.fromhex(submission_id[2:])).call()
    challenge_id, challenger, recipient, committed_at, candidate_digest = s
    if int(challenge_id) == 0:
        return None
    return {"challenge_id": str(challenge_id), "challenger": challenger.lower(), "recipient": recipient.lower(),
            "committed_at": int(committed_at), "candidate_digest": from_bytes32(candidate_digest)}


def _receipt(hash_: str, timeout: int = 60):
    web3, c = contract()
    try:
        rcpt = web3.eth.wait_for_transaction_receipt(hash_, timeout=timeout)
    except Exception as e:
        raise ChainError(f"transaction {hash_} not found or not mined: {type(e).__name__}") from e
    return web3, c, rcpt


def _track(conn: sqlite3.Connection, hash_: str, kind: str, status: str, challenge_id: int | None, frm: str | None,
           detail: dict | None = None, block: int | None = None, error: str | None = None) -> None:
    s = settings()
    conn.execute("INSERT INTO transactions(hash, chain_id, kind, status, challenge_id, from_addr, detail, block_number, error, created_at, updated_at) "
                 "VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chain_id, hash) DO UPDATE SET status=excluded.status, "
                 "detail=excluded.detail, block_number=excluded.block_number, error=excluded.error, updated_at=excluded.updated_at",
                 (hash_.lower(), s.chain_id, kind, status, challenge_id, frm, dumps(detail or {}), block, error, now(), now()))


# --------------------------------------------------------------------------- funding
def verify_funding(conn: sqlite3.Connection, challenge_row: dict, spec: dict, tx_hash: str) -> dict:
    """Read the ChallengeCreated event from the receipt and check it against the spec."""
    web3, c, rcpt = _receipt(tx_hash)
    cid = challenge_row["id"]
    if rcpt.status != 1:
        _track(conn, tx_hash, "fund", "failed", cid, rcpt["from"].lower(), block=rcpt.blockNumber, error="reverted")
        raise ChainError("funding transaction reverted")
    if rcpt.to is None or rcpt.to.lower() != settings().contract:
        raise ChainError("transaction was not sent to the CounterProof contract")
    events = c.events.ChallengeCreated().process_receipt(rcpt)
    if not events:
        raise ChainError("no ChallengeCreated event in the transaction")
    ev = events[0]["args"]
    problems = []
    if from_bytes32(ev["specDigest"]) != challenge_row["spec_digest"]:
        problems.append("spec digest on chain differs from this challenge")
    if ev["evaluator"].lower() != spec["evaluator"]["address"]:
        problems.append("evaluator on chain differs from the spec")
    if str(ev["reward"]) != spec["reward"]["amount_wei"]:
        problems.append(f"reward on chain {ev['reward']} differs from the spec {spec['reward']['amount_wei']}")
    if int(ev["submissionDeadline"]) != spec["deadlines"]["submission_deadline"] or \
            int(ev["settlementDeadline"]) != spec["deadlines"]["settlement_deadline"]:
        problems.append("deadlines on chain differ from the spec")
    if ev["publisher"].lower() != spec["publisher"]["address"]:
        problems.append("publisher on chain differs from the spec")
    if problems:
        _track(conn, tx_hash, "fund", "confirmed", cid, rcpt["from"].lower(), {"problems": problems}, rcpt.blockNumber)
        raise ChainError("; ".join(problems))
    onchain_id = str(ev["challengeId"])
    with tx(conn):
        _track(conn, tx_hash, "fund", "confirmed", cid, rcpt["from"].lower(),
               {"onchain_id": onchain_id, "reward_wei": str(ev["reward"])}, rcpt.blockNumber)
        conn.execute("UPDATE challenges SET status='funded', onchain_id=?, fund_tx=?, updated_at=? WHERE id=?",
                     (onchain_id, tx_hash.lower(), now(), cid))
        log_activity(conn, "challenge.funded", f"Funded on {network_label()}: challenge #{onchain_id}, "
                     f"{ev['reward']} wei in escrow (block {rcpt.blockNumber})", cid, tx_hash.lower())
    return {"onchain_id": onchain_id, "block": rcpt.blockNumber}


# --------------------------------------------------------------------------- challenger bot
def challenger_identity() -> tuple[str, str]:
    """The challenger bot's address (and payout recipient). Derived from its key if set."""
    key = os.environ.get("COUNTERPROOF_CHALLENGER_PRIVATE_KEY")
    if key:
        from eth_account import Account

        addr = Account.from_key(key).address.lower()
        recipient = (os.environ.get("COUNTERPROOF_CHALLENGER_RECIPIENT") or addr).lower()
        return addr, recipient
    addr = (os.environ.get("COUNTERPROOF_CHALLENGER_ADDRESS") or "0x000000000000000000000000000000000000c0de").lower()
    return addr, (os.environ.get("COUNTERPROOF_CHALLENGER_RECIPIENT") or addr).lower()


def _send(fn, key: str, value: int = 0) -> str:
    from eth_account import Account

    web3 = w3()
    acct = Account.from_key(key)
    txd = fn.build_transaction({"from": acct.address, "nonce": web3.eth.get_transaction_count(acct.address, "pending"),
                                "value": value, "chainId": web3.eth.chain_id})
    # Monad bills the gas *limit*: keep it close to the estimate.
    txd["gas"] = int(web3.eth.estimate_gas(txd) * 1.15) + 5_000
    signed = acct.sign_transaction(txd)
    return "0x" + web3.eth.send_raw_transaction(signed.raw_transaction).hex().removeprefix("0x")


def commit_submission_as_challenger(conn: sqlite3.Connection, challenge_row: dict, cand: dict, body: dict) -> dict:
    key = os.environ.get("COUNTERPROOF_CHALLENGER_PRIVATE_KEY")
    if not key:
        raise ChainError("COUNTERPROOF_CHALLENGER_PRIVATE_KEY is not set; the challenger bot cannot commit on chain. "
                         "Commit from a wallet instead and use POST /api/challenges/{id}/submissions.")
    addr, _ = challenger_identity()
    if body["challenger"] != addr:
        raise ChainError("candidate challenger differs from the configured challenger key")
    _, c = contract()
    fn = c.functions.commitSubmission(int(challenge_row["onchain_id"]), bytes.fromhex(to_bytes32(cand["digest"])[2:]),
                                      w3().to_checksum_address(body["recipient"]))
    h = _send(fn, key)
    web3, c, rcpt = _receipt(h)
    if rcpt.status != 1:
        _track(conn, h, "commit", "failed", challenge_row["id"], addr, block=rcpt.blockNumber, error="reverted")
        raise ChainError("commit transaction reverted")
    ev = c.events.SubmissionCommitted().process_receipt(rcpt)[0]["args"]
    sid = "0x" + bytes(ev["submissionId"]).hex()
    _track(conn, h, "commit", "confirmed", challenge_row["id"], addr, {"submission_id": sid}, rcpt.blockNumber)
    return {"id": sid, "source": "chain", "commit_tx": h.lower(), "committed_at": web3.eth.get_block(rcpt.blockNumber).timestamp}


# --------------------------------------------------------------------------- attestation
# The signer verifies every submission itself (a fresh k-of-n replay of the committed
# candidate) before it signs, which takes minutes for a live model. The API therefore asks
# through a worker job of kind "attestation" that polls the signer until it signs, refuses
# or reports a failure; nothing here blocks on the replay.
ATTESTATION_MARGIN = 300        # a stored attestation is reused only while it has more time left than this
ATTESTATION_POLL_SECONDS = 10.0  # how often the attestation job asks the signer again
ATTESTATION_POLL_LIMIT = 3600.0  # how long one attestation job keeps asking (a live replay takes minutes)
ACTIVE_JOB = ("queued", "running", "cancelling")


def attestation_usable(a: dict | None, at: int | None = None) -> bool:
    return bool(a) and a["expiry"] - (now() if at is None else at) > ATTESTATION_MARGIN


def attestation_job(conn: sqlite3.Connection, *, evaluation_id: str | None = None, challenge_id: int | None = None,
                    active_only: bool = False) -> dict | None:
    """The latest attestation job for an evaluation or a challenge."""
    where, args = ["kind='attestation'"], []
    if evaluation_id is not None:
        where.append("json_extract(params, '$.evaluation_id')=?")
        args.append(evaluation_id)
    if challenge_id is not None:
        where.append("json_extract(params, '$.challenge_id')=?")
        args.append(challenge_id)
    if active_only:
        where.append(f"status IN ({','.join('?' * len(ACTIVE_JOB))})")
        args += list(ACTIVE_JOB)
    return row(conn.execute(f"SELECT * FROM jobs WHERE {' AND '.join(where)} ORDER BY created_at DESC, rowid DESC LIMIT 1",
                            args).fetchone())


def enqueue_attestation(conn: sqlite3.Connection, eid: str) -> dict:
    """Queue an attestation job for this evaluation, or return the one already active."""
    from . import jobs, services

    e = services.get_evaluation(conn, eid)
    with tx(conn):
        active = attestation_job(conn, evaluation_id=eid, active_only=True)
        if active:
            return active
        jid = jobs.enqueue(conn, "attestation", {"evaluation_id": eid, "challenge_id": e["challenge_id"]})
        log_activity(conn, "attestation.queued", "Attestation requested: the evaluator's signer will replay the committed "
                     "candidate itself before it signs", e["challenge_id"], eid)
    return jobs.get(conn, jid)


def start_attestation(conn: sqlite3.Connection, eid: str) -> tuple[int, dict]:
    """POST /api/evaluations/{eid}/attest: (200, usable attestation) or (202, queued/verifying job)."""
    from . import services

    existing = row(conn.execute("SELECT * FROM attestations WHERE evaluation_id=?", (eid,)).fetchone())
    if attestation_usable(existing):
        return 200, existing
    e = services.get_evaluation(conn, eid)
    c = services.get_challenge(conn, e["challenge_id"])
    if c["status"] != "funded":
        raise ChainError(f"challenge is {c['status']}; nothing to attest")
    summary = e["summary"] if isinstance(e["summary"], dict) else {}
    if e["outcome"] != "verified_violation" or not summary.get("reward_eligible"):
        raise ChainError("only a reward-eligible verified violation can be attested")
    job = enqueue_attestation(conn, eid)
    return 202, {"status": "verifying" if job["status"] == "running" else "queued", "job_id": job["id"],
                 "evaluation_id": eid, "job": job, "attestation": existing}


def _signer_post(body: dict) -> httpx.Response:
    s = settings()
    headers = {"Authorization": f"Bearer {s.signer_token}"} if s.signer_token else {}
    return httpx.post(f"{s.signer_url}/attest", json=body, headers=headers, timeout=120)


def _store_attestation(conn: sqlite3.Connection, c: dict, e: dict, a: dict) -> tuple[dict, str]:
    """Insert the signer's attestation, or update the challenge's row when it was renewed."""
    verification = dumps(a["verification"]) if a.get("verification") else None
    t = now()
    with tx(conn):
        cur = row(conn.execute("SELECT * FROM attestations WHERE challenge_id=?", (c["id"],)).fetchone())
        if cur is None:
            conn.execute("INSERT INTO attestations(id, challenge_id, evaluation_id, submission_id, typed_data, signature, signer, "
                         "expiry, created_at, evidence_digest, verification, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                         (a["attestation_id"], c["id"], e["id"], e["submission_id"], dumps(a["typed_data"]), a["signature"],
                          a["signer"], a["expiry"], t, a.get("evidence_digest"), verification, t))
            v = a.get("verification") or {}
            how = (f" after its own replays violated the rule in {v.get('violated')} of {v.get('replays')}"
                   if v.get("replays") else "")
            log_activity(conn, "attestation.signed", f"Evaluator {a['signer'][:10]}... signed the attestation{how} "
                         f"(expires {a['expiry']})", c["id"], a["attestation_id"])
            change = "signed"
        elif cur["evaluation_id"] != e["id"]:
            raise ChainError("this challenge already holds an attestation for another evaluation")
        elif cur["id"] != a["attestation_id"] or cur["expiry"] != a["expiry"]:
            conn.execute("UPDATE attestations SET id=?, typed_data=?, signature=?, signer=?, expiry=?, evidence_digest=?, "
                         "verification=COALESCE(?, verification), updated_at=? WHERE challenge_id=?",
                         (a["attestation_id"], dumps(a["typed_data"]), a["signature"], a["signer"], a["expiry"],
                          a.get("evidence_digest"), verification, t, c["id"]))
            if a.get("kind") == "reverified":
                log_activity(conn, "attestation.signed", f"Evaluator {a['signer'][:10]}... replayed the submission itself and "
                             f"signed a new attestation over its own evidence (expires {a['expiry']}; replaces {cur['id']}, "
                             "signed before the signer verified submissions itself)", c["id"], a["attestation_id"])
                change = "reverified"
            else:
                log_activity(conn, "attestation.renewed", f"Evaluator {a['signer'][:10]}... re-signed the same attestation with a "
                             f"new expiry {a['expiry']} (was {cur['expiry']}; replaces {cur['id']})", c["id"], a["attestation_id"])
                change = "renewed"
        else:
            change = "unchanged"
    return row(conn.execute("SELECT * FROM attestations WHERE challenge_id=?", (c["id"],)).fetchone()), change


def request_attestation(conn: sqlite3.Connection, eid: str, retry_failed: bool = True) -> dict:
    """Ask the signer once. Returns {"status": signed | pending | refused | failed | unavailable, ...}.

    A stored attestation is returned without asking only while it is usable (more than
    ATTESTATION_MARGIN seconds left); otherwise the signer is asked to renew it.
    `retry_failed=False` polls: a failed verification is reported instead of re-run."""
    from . import services

    existing = row(conn.execute("SELECT * FROM attestations WHERE evaluation_id=?", (eid,)).fetchone())
    if attestation_usable(existing):
        return {"status": "signed", "change": "stored", "attestation": existing}
    e = services.get_evaluation(conn, eid)
    c = services.get_challenge(conn, e["challenge_id"])
    if c["status"] != "funded":
        raise ChainError(f"challenge is {c['status']}; nothing to attest")
    body = {"evaluation_id": eid, "evidence_digest": e["evidence_digest"], "spec_digest": c["spec_digest"],
            "onchain_challenge_id": c["onchain_id"], "submission_id": e["submission_id"], "retry_failed": retry_failed}
    try:
        r = _signer_post(body)
    except httpx.HTTPError as ex:
        return {"status": "unavailable", "detail": f"signer unreachable at {settings().signer_url}: {type(ex).__name__}"}
    try:
        a = r.json()
    except ValueError:
        a = {}
    if not isinstance(a, dict):
        a = {}
    if r.status_code == 200 and a.get("status", "signed") == "signed":
        stored, change = _store_attestation(conn, c, e, a)
        return {"status": "signed", "change": change, "attestation": stored}
    if r.status_code == 202:
        return {"status": "pending", "signer_status": a.get("status"), "verification": a.get("verification"),
                "detail": a.get("reason")}
    detail = a.get("detail")
    if r.status_code == 409:
        reasons = a.get("refused") or ([detail] if isinstance(detail, str) else (detail or {}).get("refused")) or [r.text[:300]]
        return {"status": "refused", "signer_status": a.get("status"), "refused": [redact(str(x))[:400] for x in reasons],
                "verification": a.get("verification")}
    if r.status_code == 503:
        return {"status": "failed", "retryable": True, "detail": redact(str(a.get("reason") or detail or r.text))[:400],
                "verification": a.get("verification")}
    return {"status": "unavailable", "detail": f"signer answered HTTP {r.status_code}: {redact(str(detail or r.text))[:300]}"}


# --------------------------------------------------------------------------- settlement & payouts
def verify_tx(conn: sqlite3.Connection, challenge_row: dict, tx_hash: str, kind: str) -> dict:
    """Record a settle/refund/withdraw transaction from its receipt and events."""
    web3, c, rcpt = _receipt(tx_hash)
    cid = challenge_row["id"]
    frm = rcpt["from"].lower()
    if rcpt.status != 1:
        _track(conn, tx_hash, kind, "failed", cid, frm, block=rcpt.blockNumber, error="reverted")
        log_activity(conn, f"{kind}.failed", f"{kind} transaction reverted on {network_label()}", cid, tx_hash.lower())
        return {"status": "failed"}
    detail: dict = {}
    if kind == "settle":
        evs = c.events.ChallengeSettled().process_receipt(rcpt)
        if not evs or str(evs[0]["args"]["challengeId"]) != challenge_row["onchain_id"]:
            raise ChainError("no ChallengeSettled event for this challenge in the transaction")
        a = evs[0]["args"]
        detail = {"submission_id": "0x" + bytes(a["submissionId"]).hex(), "recipient": a["recipient"].lower(),
                  "reward_wei": str(a["reward"]), "evidence_digest": from_bytes32(a["evidenceDigest"])}
        conn.execute("UPDATE challenges SET status='settled', updated_at=? WHERE id=?", (now(), cid))
        msg = f"Settled on {network_label()}: {a['reward']} wei credited to {detail['recipient']}"
    elif kind == "refund":
        evs = c.events.ChallengeRefunded().process_receipt(rcpt)
        if not evs:
            raise ChainError("no ChallengeRefunded event in the transaction")
        conn.execute("UPDATE challenges SET status='refunded', updated_at=? WHERE id=?", (now(), cid))
        detail = {"publisher": evs[0]["args"]["publisher"].lower(), "reward_wei": str(evs[0]["args"]["reward"])}
        msg = f"Refunded on {network_label()}: reward returned to the publisher's credit"
    elif kind == "withdraw":
        evs = c.events.Withdrawn().process_receipt(rcpt)
        if not evs:
            raise ChainError("no Withdrawn event in the transaction")
        a = evs[0]["args"]
        detail = {"account": a["account"].lower(), "to": a["to"].lower(), "amount_wei": str(a["amount"])}
        msg = f"Withdrawn on {network_label()}: {a['amount']} wei paid to {detail['to']}"
    else:
        raise ChainError(f"unknown transaction kind {kind}")
    _track(conn, tx_hash, kind, "confirmed", cid, frm, detail, rcpt.blockNumber)
    log_activity(conn, f"{kind}.confirmed", msg + f" (block {rcpt.blockNumber})", cid, tx_hash.lower())
    return {"status": "confirmed", "detail": detail, "explorer": explorer_tx(tx_hash)}


def record_failed_tx(conn: sqlite3.Connection, challenge_id: int, tx_hash: str | None, kind: str, error: str) -> None:
    """A wallet rejection or a send error reported by the browser (no receipt exists)."""
    log_activity(conn, f"{kind}.failed", f"{kind} not sent: {redact(error)[:200]}", challenge_id, tx_hash)
    if tx_hash:
        _track(conn, tx_hash, kind, "failed", challenge_id, None, error=redact(error)[:300])
