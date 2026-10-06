"""Evaluator signing service: `python -m counterproof.signer` (127.0.0.1:8011).

This is the only process that holds EVALUATOR_PRIVATE_KEY. The API, worker, strategies
and target sandboxes never see it. Before signing, the signer independently:

1. loads the spec and evidence bundle by digest from the content-addressed store and
   verifies both digests;
2. re-verifies the bundle: seal, every ledger hash chain, a fresh run of the checker over
   the recorded ledgers, the reproducibility policy and reward eligibility;
3. for deterministic targets, replays the candidate itself in a fresh sandbox and requires
   the same ledger digest;
4. reads the challenge and the submission from the chain: same spec digest, this signer is
   the declared evaluator, challenge still funded and inside its settlement window,
   submission committed by the bound challenger for the bound recipient and candidate;
5. refuses a second attestation for a challenge it has already attested (one reward per
   challenge); repeating a request for the same submission returns the same attestation.

The result is an EIP-712 `Attestation` the contract verifies. It is an attestation by a
declared trusted evaluator - not a proof the contract can check by itself.
"""

from __future__ import annotations

import hmac
import os
import sqlite3
import time

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel

from .canonical import digest, to_bytes32
from .config import settings
from .db import ArtifactStore
from .evaluator import recheck_bundle
from .runner.sandbox import select_backend
from .runner.session import RunLimits, run_fresh
from .spec import code_mismatches

ATTESTATION_TYPES = {
    "Attestation": [
        {"name": "challengeId", "type": "uint256"},
        {"name": "specDigest", "type": "bytes32"},
        {"name": "submissionId", "type": "bytes32"},
        {"name": "candidateDigest", "type": "bytes32"},
        {"name": "evidenceDigest", "type": "bytes32"},
        {"name": "challenger", "type": "address"},
        {"name": "recipient", "type": "address"},
        {"name": "verdict", "type": "uint8"},
        {"name": "expiry", "type": "uint64"},
    ]
}
VERDICT_VERIFIED_VIOLATION = 1
ATTESTATION_TTL = 3600


def domain(chain_id: int, contract: str) -> dict:
    from web3 import Web3

    return {"name": "CounterProof", "version": "1", "chainId": chain_id, "verifyingContract": Web3.to_checksum_address(contract)}


def sign_attestation(key: str, chain_id: int, contract: str, message: dict) -> tuple[str, dict]:
    """Sign an Attestation. `message` uses 0x-hex bytes32 strings and lower-case addresses."""
    from eth_account import Account
    from web3 import Web3

    msg = dict(message)
    for k in ("specDigest", "submissionId", "candidateDigest", "evidenceDigest"):
        msg[k] = bytes.fromhex(msg[k][2:])
    for k in ("challenger", "recipient"):
        msg[k] = Web3.to_checksum_address(msg[k])
    signed = Account.sign_typed_data(key, domain_data=domain(chain_id, contract), message_types=ATTESTATION_TYPES, message_data=msg)
    typed = {"domain": domain(chain_id, contract), "types": ATTESTATION_TYPES, "primaryType": "Attestation", "message": message}
    return "0x" + bytes(signed.signature).hex(), typed


class AttestRequest(BaseModel):
    evaluation_id: str
    evidence_digest: str
    spec_digest: str
    onchain_challenge_id: str
    submission_id: str


def _db() -> sqlite3.Connection:
    p = settings().data_dir / "signer.sqlite"
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(p, timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE IF NOT EXISTS signed (chain_id INTEGER, contract TEXT, challenge_id TEXT, submission_id TEXT, "
                 "evidence_digest TEXT, attestation_id TEXT, typed_data TEXT, signature TEXT, expiry INTEGER, created_at INTEGER, "
                 "PRIMARY KEY (chain_id, contract, challenge_id))")
    return conn


def create_app() -> FastAPI:
    key = os.environ.get("EVALUATOR_PRIVATE_KEY")
    token = settings().signer_token
    app = FastAPI(title="CounterProof evaluator signer", docs_url=None, redoc_url=None, openapi_url=None)

    def auth(authorization: str | None = Header(default=None)) -> None:
        if token and not hmac.compare_digest(authorization or "", f"Bearer {token}"):
            raise HTTPException(401, "unauthorised")

    @app.get("/health")
    def health() -> dict:
        from eth_account import Account

        return {"configured": bool(key), "address": Account.from_key(key).address.lower() if key else None,
                "network": settings().network, "contract": settings().contract}

    @app.post("/attest", dependencies=[Depends(auth)])
    def attest(req: AttestRequest) -> dict:
        import json

        from eth_account import Account

        from . import chain

        if not key:
            raise HTTPException(503, "EVALUATOR_PRIVATE_KEY is not configured in the signer process")
        s = settings()
        me = Account.from_key(key).address.lower()
        store = ArtifactStore()
        try:
            spec = store.get(req.spec_digest)
            bundle = store.get(req.evidence_digest)
        except (ValueError, FileNotFoundError) as e:
            raise HTTPException(400, f"artifact unavailable or corrupted: {e}") from e
        problems = recheck_bundle(bundle, spec)
        if bundle["challenge"]["spec_digest"] != req.spec_digest:
            problems.append("bundle belongs to a different specification")
        if spec["evaluator"]["address"] != me:
            problems.append("this signer is not the evaluator declared in the specification")
        if spec["settlement"] is None or spec["settlement"]["chain_id"] != s.chain_id or spec["settlement"]["contract"] != s.contract:
            problems.append("specification settles on a different chain or contract")
        if bundle["submission"]["submission_id"] != req.submission_id:
            problems.append("bundle was produced for a different submission")
        problems += code_mismatches(spec)
        if problems:
            raise HTTPException(409, {"refused": problems})

        conn = _db()
        prior = conn.execute("SELECT * FROM signed WHERE chain_id=? AND contract=? AND challenge_id=?",
                             (s.chain_id, s.contract, req.onchain_challenge_id)).fetchone()
        if prior:
            if prior["submission_id"] != req.submission_id:
                raise HTTPException(409, {"refused": ["this challenge already has an attestation for another submission"]})
            return {"attestation_id": prior["attestation_id"], "typed_data": json.loads(prior["typed_data"]),
                    "signature": prior["signature"], "signer": me, "expiry": prior["expiry"], "repeated": True}

        # independent replay for deterministic targets
        cand = bundle["candidate"]
        if spec["reproducibility"]["mode"] == "deterministic":
            backend = select_backend(spec["environment"]["isolation"])
            res = run_fresh(backend=backend, adapter_key=f"{spec['target']['adapter']}@{spec['target']['version']}",
                            config=spec["target"]["config"], initial_state=spec["initial_state"], actions=cand["actions"],
                            limits=RunLimits.from_spec(spec["limits"]))
            if res.ledger_digest != bundle["replays"][0]["ledger_digest"]:
                raise HTTPException(409, {"refused": ["signer's own replay produced a different ledger"]})

        # on-chain bindings
        try:
            ch = chain.read_challenge(int(req.onchain_challenge_id))
            sub = chain.read_submission(req.submission_id)
        except Exception as e:
            raise HTTPException(502, f"could not read the chain: {type(e).__name__}") from e
        now = int(time.time())
        checks = []
        if ch["spec_digest"] != req.spec_digest:
            checks.append("on-chain spec digest differs")
        if ch["evaluator"] != me:
            checks.append("on-chain evaluator is not this signer")
        if ch["status"] != "funded":
            checks.append(f"challenge is {ch['status']} on chain")
        if now > ch["settlement_deadline"]:
            checks.append("settlement window has closed")
        if sub is None or sub["challenge_id"] != req.onchain_challenge_id:
            checks.append("submission not committed on chain for this challenge")
        else:
            if sub["candidate_digest"] != digest(cand):
                checks.append("committed candidate digest differs from the evaluated candidate")
            if sub["challenger"] != cand["challenger"] or sub["recipient"] != cand["recipient"]:
                checks.append("committed challenger/recipient differ from the candidate")
            if sub["committed_at"] > ch["submission_deadline"]:
                checks.append("submission was committed after the deadline")
        if checks:
            raise HTTPException(409, {"refused": checks})

        expiry = min(now + ATTESTATION_TTL, ch["settlement_deadline"])
        message = {"challengeId": int(req.onchain_challenge_id), "specDigest": to_bytes32(req.spec_digest),
                   "submissionId": req.submission_id, "candidateDigest": to_bytes32(digest(cand)),
                   "evidenceDigest": to_bytes32(req.evidence_digest), "challenger": sub["challenger"],
                   "recipient": sub["recipient"], "verdict": VERDICT_VERIFIED_VIOLATION, "expiry": expiry}
        signature, typed = sign_attestation(key, s.chain_id, s.contract, message)
        att_id = "att_" + digest({"typed": typed})[7:23]
        conn.execute("INSERT INTO signed VALUES (?,?,?,?,?,?,?,?,?,?)",
                     (s.chain_id, s.contract, req.onchain_challenge_id, req.submission_id, req.evidence_digest, att_id,
                      json.dumps(typed), signature, expiry, now))
        return {"attestation_id": att_id, "typed_data": typed, "signature": signature, "signer": me, "expiry": expiry}

    return app


def main() -> None:
    import uvicorn

    port = int(os.environ.get("COUNTERPROOF_SIGNER_PORT", "8011"))
    uvicorn.run(create_app(), host="127.0.0.1", port=port, log_level="info")


if __name__ == "__main__":
    main()
