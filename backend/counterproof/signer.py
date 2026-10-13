"""Evaluator signing service: `python -m counterproof.signer` (127.0.0.1:8011).

This is the only process that holds EVALUATOR_PRIVATE_KEY. The API, worker, strategies
and target sandboxes never see it.

The signer trusts nothing the API or the worker produced. Their evaluation id and evidence
digest are recorded as a provenance reference only; they are never a gate. A worker (or an
API) that can write into the shared content-addressed store could fabricate ledgers,
recompute their hash chains and reseal a bundle that passes `recheck_bundle`, so before it
signs, the signer verifies EVERY target - deterministic and live-model - itself:

1. reads the challenge and the submission from the chain FIRST: same spec digest as the
   request, this signer is the declared evaluator, challenge still funded and inside its
   settlement window, submission committed for this challenge before the submission
   deadline;
2. loads the funded spec by its on-chain digest and the COMMITTED candidate by the on-chain
   candidate digest from the store (`ArtifactStore.get` verifies both digests); checks the
   spec's evaluator, chain and contract and that the installed code matches the digests
   the spec was funded against;
3. replays the committed candidate itself with `evaluator.evaluate` - the same k-of-n
   reproducibility policy the spec declares, every replay in a fresh isolated child, the
   deterministic checker - using the binding read from the chain, and a model broker that
   runs INSIDE THIS PROCESS (the trusted side). Target children are started with the
   minimal environment by the runner and receive neither the provider key nor the
   evaluator key;
4. signs only if its OWN bundle is a reward-eligible verified violation, passes
   `recheck_bundle`, and its submission binding equals the chain. The signed
   `evidenceDigest` is the digest of the signer's own bundle, which it stores in the shared
   store (sealed body under its seal digest, as `services.put_evidence` does) so the API
   can serve exactly the evidence that was validated.

A live-model verification takes minutes, so it runs in a background thread with its state
in signer.sqlite (`verifications`). POST /attest answers:

* 200 `{"status": "signed", ...}`     the attestation (new, renewed or unchanged);
* 202 `{"status": "verifying"}`       the signer is replaying; ask again later;
* 202 `{"status": "waiting"}`         another submission for this challenge is being verified first;
* 409 `{"status": "rejected"|"refused", "refused": [...]}`  final refusal (not reproduced,
  below the threshold, not eligible, binding mismatch, another submission already holds
  the challenge, settled / refunded / window closed);
* 503 `{"status": "failed", "retryable": true}`  the verification could not run (provider
  failure, missing credential, isolation unavailable, infrastructure crash). Explicitly
  non-paying, and a later request retries it;
* 502  the chain could not be read (nothing recorded).

Renewal: an attestation lives at most ATTESTATION_TTL seconds and never past the settlement
deadline. A repeated request for the attested submission re-reads the chain and
re-verifies the signer's stored evidence (digest, seal, `recheck_bundle`, binding against
the chain). While the attestation has more than RENEW_MARGIN seconds left it is returned
unchanged; otherwise the SAME message is signed again with only the expiry moved to
min(now + TTL, settlement deadline). Renewal never re-runs stochastic replays. Every
signature is kept in `attestation_history`. One reward per challenge: an attestation for a
different submission is refused.

The signer's own state is not trusted either. signer.sqlite lives in COUNTERPROOF_DATA_DIR,
which the API and the worker can write (same directory as the store, same OS user in the
shipped launchers), so nothing read back from it becomes a signature on trust:

* a stored attestation is used at all (repeated, renewed, or held against another
  submission) only if its signature recovers to this key over exactly the stored message
  and the row agrees with that message; otherwise the request is refused;
* a renewal additionally needs the `verified` row to carry this signer's MAC
  (HMAC-SHA256 under a key derived from EVALUATOR_PRIVATE_KEY) over (chain, contract,
  challenge, submission, own evidence digest), written only when its own replay verified
  the evidence. A row without a valid MAC is treated like a legacy attestation: returned
  unchanged while still usable, verified independently again once expired.

Whoever can write signer.sqlite can still delete or alter rows - a denial of service and an
unreliable `attestation_history` - but cannot obtain a signature the signer would not issue
after its own verification.

Concurrency: every decision for a challenge runs under a per-challenge lock and every
write in a `BEGIN IMMEDIATE` transaction; at most one verification runs per challenge, so
two submissions racing for one challenge can never both be signed.

The result is an EIP-712 `Attestation` the contract verifies. It is an attestation by a
declared trusted evaluator - not a proof the contract can check by itself.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import sqlite3
import threading
import time
from contextlib import closing
from typing import Callable

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import chain
from .canonical import digest, to_bytes32
from .config import settings
from .db import ArtifactStore
from .evaluator import evaluate, recheck_bundle
from .providers import MissingCredential, broker_for_spec
from .redact import redact
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
RENEW_MARGIN = 300  # an attestation with less time left than this is renewed instead of repeated
SYNC_WAIT = 10.0  # seconds a request waits for a verification it started (deterministic ones finish)
# Verifications replaying at once across all challenges (each spawns isolated children and
# may call a rate-limited model provider); further ones wait, still reported as verifying.
MAX_PARALLEL = int(os.environ.get("COUNTERPROOF_SIGNER_PARALLEL", "2"))

log = logging.getLogger("counterproof.signer")

SCHEMA = [
    # The current attestation per challenge (one reward per challenge).
    "CREATE TABLE IF NOT EXISTS signed (chain_id INTEGER, contract TEXT, challenge_id TEXT, submission_id TEXT, "
    "evidence_digest TEXT, attestation_id TEXT, typed_data TEXT, signature TEXT, expiry INTEGER, created_at INTEGER, "
    "PRIMARY KEY (chain_id, contract, challenge_id))",
    # The signer's own verification of each submission it was asked about.
    "CREATE TABLE IF NOT EXISTS verifications (chain_id INTEGER NOT NULL, contract TEXT NOT NULL, "
    "challenge_id TEXT NOT NULL, submission_id TEXT NOT NULL, status TEXT NOT NULL, outcome TEXT, reason TEXT, "
    "evidence_digest TEXT, worker_evaluation_id TEXT, worker_evidence_digest TEXT, mode TEXT, replays INTEGER, "
    "replays_done INTEGER NOT NULL DEFAULT 0, violated INTEGER, required INTEGER, started_at INTEGER NOT NULL, "
    "finished_at INTEGER, attempt INTEGER NOT NULL DEFAULT 1, mac TEXT, "
    "PRIMARY KEY (chain_id, contract, challenge_id, submission_id))",
    "CREATE UNIQUE INDEX IF NOT EXISTS verifications_one_running ON verifications(chain_id, contract, challenge_id) "
    "WHERE status='verifying'",
    "CREATE UNIQUE INDEX IF NOT EXISTS verifications_one_verified ON verifications(chain_id, contract, challenge_id) "
    "WHERE status='verified'",
    # Audit trail of every signature issued (initial, renewal, reverified).
    "CREATE TABLE IF NOT EXISTS attestation_history (id INTEGER PRIMARY KEY AUTOINCREMENT, chain_id INTEGER NOT NULL, "
    "contract TEXT NOT NULL, challenge_id TEXT NOT NULL, submission_id TEXT NOT NULL, attestation_id TEXT NOT NULL, "
    "previous_id TEXT, evidence_digest TEXT, expiry INTEGER NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL)",
]


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


def recover_attestation_signer(typed: dict, signature: str) -> str:
    """The address whose key produced `signature` over the Attestation in `typed` (lower case).
    The types are always ATTESTATION_TYPES, never the stored ones."""
    from eth_account import Account
    from eth_account.messages import encode_typed_data
    from web3 import Web3

    m = dict(typed["message"])
    for k in ("specDigest", "submissionId", "candidateDigest", "evidenceDigest"):
        m[k] = bytes.fromhex(m[k][2:])
    for k in ("challenger", "recipient"):
        m[k] = Web3.to_checksum_address(m[k])
    enc = encode_typed_data(domain_data=typed["domain"], message_types=ATTESTATION_TYPES, message_data=m)
    return Account.recover_message(enc, signature=signature).lower()


class AttestRequest(BaseModel):
    spec_digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    onchain_challenge_id: str = Field(pattern=r"^[0-9]{1,30}$")
    submission_id: str = Field(pattern=r"^0x[0-9a-fA-F]{64}$")
    # Provenance only: what the API/worker evaluated. Recorded, never trusted, never a gate.
    evaluation_id: str | None = Field(default=None, max_length=128)
    evidence_digest: str | None = Field(default=None, max_length=80)
    # A new request retries a verification that failed (provider down, crash); a poll for
    # the outcome of the running one sends False so a failure is reported, not re-run.
    retry_failed: bool = True


def _db() -> sqlite3.Connection:
    p = settings().data_dir / "signer.sqlite"
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(p, timeout=30, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def _init_db() -> None:
    with closing(_db()) as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            for stmt in SCHEMA:
                conn.execute(stmt)
            if "mac" not in {r["name"] for r in conn.execute("PRAGMA table_info(verifications)")}:
                conn.execute("ALTER TABLE verifications ADD COLUMN mac TEXT")  # signer.sqlite from before the MAC
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise


def _row(r: sqlite3.Row | None) -> dict | None:
    return dict(r) if r is not None else None


def _reply(status_code: int, body: dict) -> JSONResponse:
    return JSONResponse(status_code=status_code, content=body)


def _refused(reasons: list[str], status: str = "refused") -> JSONResponse:
    return _reply(409, {"status": status, "refused": reasons, "retryable": False})


def _failed(reason: str, verification: dict | None = None) -> JSONResponse:
    return _reply(503, {"status": "failed", "reason": reason, "retryable": True, "verification": verification})


def verification_summary(v: dict | None) -> dict | None:
    """The signer's own verification as reported to the API (no secrets, no worker trust)."""
    if not v:
        return None
    return {"by": "evaluator signer", "status": v["status"], "outcome": v["outcome"], "reason": v["reason"],
            "mode": v["mode"], "replays": v["replays"], "replays_done": v["replays_done"], "violated": v["violated"],
            "required": v["required"], "evidence_digest": v["evidence_digest"], "attempt": v["attempt"],
            "started_at": v["started_at"], "finished_at": v["finished_at"],
            "worker_evaluation_id": v["worker_evaluation_id"], "worker_evidence_digest": v["worker_evidence_digest"]}


def _store_bundle(store: ArtifactStore, bundle: dict) -> str:
    """Store the sealed body under its seal digest (the convention of services.put_evidence)."""
    body = {k: v for k, v in bundle.items() if k != "evidence_digest"}
    d = store.put(body)
    if d != bundle.get("evidence_digest"):
        raise ValueError("the signer's own bundle seal does not match its contents")
    return d


def _load_bundle(store: ArtifactStore, d: str) -> dict:
    body = store.get(d)  # verifies the digest of what is stored
    return body if "evidence_digest" in body else {**body, "evidence_digest": d}


def _binding_problems(bundle: dict, binding: dict, spec_dgst: str) -> list[str]:
    """The submission binding inside a bundle must equal the one read from the chain."""
    out = []
    sub = bundle.get("submission") or {}
    if bundle.get("challenge", {}).get("spec_digest") != spec_dgst:
        out.append("evidence belongs to a different specification")
    if str(bundle.get("challenge", {}).get("onchain_challenge_id")) != binding["challenge_id"]:
        out.append("evidence belongs to a different on-chain challenge")
    if (sub.get("submission_id") or "").lower() != binding["submission_id"]:
        out.append("evidence was produced for a different submission")
    for f in ("challenger", "recipient"):
        if (sub.get(f) or "").lower() != binding[f]:
            out.append(f"evidence {f} differs from the on-chain commitment")
    if sub.get("candidate_digest") != binding["candidate_digest"] or sub.get("committed_candidate_digest") != binding["candidate_digest"]:
        out.append("evidence candidate differs from the committed candidate digest")
    return out


class Verifier:
    """Per-challenge locks, verification threads and the signer database for one signer app."""

    def __init__(self, key: str | None, clock: Callable[[], float], broker_factory: Callable[[dict], object],
                 sync_wait: float):
        self.key = key
        self.clock = clock
        self.broker_factory = broker_factory
        self.sync_wait = sync_wait
        self.me = None
        self._mac_key = None
        if key:
            from eth_account import Account

            self.me = Account.from_key(key).address.lower()
            # Authenticates the signer's own "verified" rows: only the holder of the evaluator
            # key can produce it, so a row planted in signer.sqlite cannot be renewed.
            raw = bytes.fromhex(key[2:] if key[:2].lower() == "0x" else key)
            self._mac_key = hmac.new(raw, b"counterproof/signer-state-mac/v1", hashlib.sha256).digest()
        self.stop = threading.Event()
        self._slots = threading.BoundedSemaphore(max(1, MAX_PARALLEL))
        self._global = threading.Lock()
        self._locks: dict[tuple, threading.Lock] = {}
        self._threads: dict[tuple, threading.Thread] = {}

    # ------------------------------------------------------------------ infrastructure
    def now(self) -> int:
        return int(self.clock())

    def lock(self, k: tuple) -> threading.Lock:
        with self._global:
            return self._locks.setdefault(k, threading.Lock())

    def alive(self, k: tuple) -> bool:
        t = self._threads.get(k)
        return t is not None and t.is_alive()

    def join(self, timeout: float | None = None) -> None:
        """Wait for every verification this app started (tests and shutdown)."""
        for t in list(self._threads.values()):
            t.join(timeout)

    # ------------------------------------------------------------------ the signer's own state
    # signer.sqlite sits in COUNTERPROOF_DATA_DIR, which the API and the worker can write.
    # Nothing read back from it becomes a signature on trust.
    def _mac(self, k: tuple, sid: str, evidence: str | None) -> str:
        msg = json.dumps([int(k[0]), str(k[1]).lower(), str(k[2]), sid.lower(), evidence, "verified"], separators=(",", ":"))
        return hmac.new(self._mac_key, msg.encode(), hashlib.sha256).hexdigest()

    def _mac_ok(self, k: tuple, sid: str, row: dict) -> bool:
        return bool(row.get("mac")) and hmac.compare_digest(row["mac"], self._mac(k, sid, row["evidence_digest"]))

    def _stored_problems(self, k: tuple, signed: dict) -> list[str]:
        """A stored attestation is used (repeated, renewed, or held against another submission)
        only if this key signed exactly the message it holds and the row agrees with it."""
        s = settings()
        try:
            typed = json.loads(signed["typed_data"])
            m = typed["message"]
            ok = (typed.get("primaryType") == "Attestation" and typed.get("types") == ATTESTATION_TYPES
                  and typed.get("domain") == domain(s.chain_id, s.contract)
                  and int(m["challengeId"]) == int(k[2])
                  and str(m["submissionId"]).lower() == str(signed["submission_id"]).lower()
                  and str(m["evidenceDigest"]).lower() == to_bytes32(signed["evidence_digest"]).lower()
                  and int(m["expiry"]) == int(signed["expiry"])
                  and recover_attestation_signer(typed, signed["signature"]) == self.me)
        except Exception:
            ok = False
        if ok:
            return []
        log.warning("challenge %s: stored attestation %s does not verify against this signer's key", k[2], signed.get("attestation_id"))
        return ["the signer's stored attestation for this challenge is not signed by this signer or does not match its "
                "record; refusing (the signer's state was altered)"]

    # ------------------------------------------------------------------ chain
    def _read_chain(self, cid: str, sid: str) -> tuple[dict, dict | None]:
        return chain.read_challenge(int(cid)), chain.read_submission(sid)

    def _chain_problems(self, ch: dict, sub: dict | None, cid: str, spec_dgst: str | None, now: int) -> list[str]:
        out = []
        if spec_dgst is not None and ch["spec_digest"] != spec_dgst:
            out.append("on-chain spec digest differs from the request")
        if ch["evaluator"] != self.me:
            out.append("on-chain evaluator is not this signer")
        if ch["status"] != "funded":
            out.append(f"challenge is {ch['status']} on chain")
        if now > ch["settlement_deadline"]:
            out.append("settlement window has closed")
        if sub is None or sub["challenge_id"] != cid:
            out.append("submission not committed on chain for this challenge")
        elif sub["committed_at"] > ch["submission_deadline"]:
            out.append("submission was committed after the deadline")
        return out

    def _spec_problems(self, spec: dict) -> list[str]:
        s = settings()
        out = []
        if spec["evaluator"]["address"] != self.me:
            out.append("this signer is not the evaluator declared in the specification")
        if spec["settlement"] is None or spec["settlement"]["chain_id"] != s.chain_id or spec["settlement"]["contract"] != s.contract:
            out.append("specification settles on a different chain or contract")
        return out

    # ------------------------------------------------------------------ request
    def attest(self, req: AttestRequest) -> JSONResponse:
        s = settings()
        if not self.key:
            return _failed("EVALUATOR_PRIVATE_KEY is not configured in the signer process")
        if s.chain_id is None or not s.contract:
            return _failed("the signer has no chain or contract configured")
        k = (s.chain_id, s.contract, req.onchain_challenge_id)
        sid = req.submission_id.lower()
        with self.lock(k):
            resp, started = self._decide(req, sid, k, allow_start=True)
        if started is not None and self.sync_wait > 0:
            started.join(self.sync_wait)
            if not started.is_alive():
                with self.lock(k):
                    resp, _ = self._decide(req, sid, k, allow_start=False)
        return resp

    def _decide(self, req: AttestRequest, sid: str, k: tuple, allow_start: bool) -> tuple[JSONResponse, threading.Thread | None]:
        cid = req.onchain_challenge_id
        try:
            ch, sub = self._read_chain(cid, sid)
        except Exception as e:
            return _reply(502, {"status": "unavailable", "detail": f"could not read the chain: {type(e).__name__}",
                                "retryable": True}), None
        now = self.now()
        problems = self._chain_problems(ch, sub, cid, req.spec_digest, now)
        if problems:
            return _refused(problems), None
        binding = {"submission_id": sid, "challenger": sub["challenger"], "recipient": sub["recipient"],
                   "candidate_digest": sub["candidate_digest"], "challenge_id": cid}
        with closing(_db()) as conn:
            signed = _row(conn.execute("SELECT * FROM signed WHERE chain_id=? AND contract=? AND challenge_id=?", k).fetchone())
            if signed:
                stored = self._stored_problems(k, signed)
                if stored:
                    return _refused(stored), None
                if signed["submission_id"].lower() != sid:
                    return _refused(["this challenge already has an attestation for another submission"]), None
                own = _row(conn.execute("SELECT * FROM verifications WHERE chain_id=? AND contract=? AND challenge_id=? "
                                        "AND submission_id=? AND status='verified' AND evidence_digest=?",
                                        (*k, sid, signed["evidence_digest"])).fetchone())
                if own is not None and not self._mac_ok(k, sid, own):
                    log.warning("challenge %s: verified row for %s lacks this signer's MAC; treated as legacy", k[2], sid)
                    own = None
                if own is not None:
                    # allow_start=False is the answer to the request that just waited for its own
                    # verification: the attestation is new to that caller, not a repeat.
                    return self._renew_or_repeat(conn, k, signed, own, ch, binding, now, repeat=allow_start), None
                if signed["expiry"] - now > RENEW_MARGIN:
                    # Signed by an earlier signer version, before independent verification (or
                    # its verified row carries no valid MAC): already issued by this key and still
                    # usable, so it is returned unchanged.
                    return _reply(200, self._attestation_body(conn, k, signed, None, repeated=True) | {"legacy": True}), None
                # An expired legacy attestation is never renewed blindly: the same submission
                # is verified independently below and signed afresh ("reverified").
            ver = _row(conn.execute("SELECT * FROM verifications WHERE chain_id=? AND contract=? AND challenge_id=? AND submission_id=?",
                                    (*k, sid)).fetchone())
            if ver and ver["status"] == "verifying":
                if self.alive(k):
                    return _reply(202, {"status": "verifying", "verification": verification_summary(ver)}), None
                self._finish(conn, k, sid, "failed", reason="interrupted: the signer stopped during this verification")
                ver = _row(conn.execute("SELECT * FROM verifications WHERE chain_id=? AND contract=? AND challenge_id=? AND submission_id=?",
                                        (*k, sid)).fetchone())
            if ver and ver["status"] == "rejected":
                return _reply(409, {"status": "rejected", "refused": [ver["reason"]], "retryable": False,
                                    "verification": verification_summary(ver)}), None
            if ver and ver["status"] == "failed" and not (allow_start and req.retry_failed):
                return _failed(ver["reason"], verification_summary(ver)), None
            if ver and ver["status"] == "verified" and not signed:
                return _refused(["the signer's records are inconsistent (verified without an attestation); "
                                 "refusing to sign"]), None
            busy = _row(conn.execute("SELECT * FROM verifications WHERE chain_id=? AND contract=? AND challenge_id=? "
                                     "AND status='verifying' AND submission_id<>?", (*k, sid)).fetchone())
            if busy:
                if self.alive(k):
                    return _reply(202, {"status": "waiting", "reason": "another submission for this challenge is being "
                                                                       "verified first; one reward per challenge"}), None
                self._finish(conn, k, busy["submission_id"], "failed", reason="interrupted: the signer stopped during this verification")
            if not allow_start:
                return _reply(202, {"status": "verifying", "verification": verification_summary(ver)}), None
            return self._start(conn, k, req, sid, ch, binding, ver, now)

    # ------------------------------------------------------------------ verification
    def _start(self, conn, k: tuple, req: AttestRequest, sid: str, ch: dict, binding: dict, ver: dict | None,
               now: int) -> tuple[JSONResponse, threading.Thread | None]:
        store = ArtifactStore()
        try:
            spec = store.get(ch["spec_digest"])
        except FileNotFoundError:
            return _failed("the funded specification is not in the shared artifact store"), None
        except ValueError as e:
            return _refused([f"the funded specification artifact failed its integrity check: {e}"]), None
        problems = self._spec_problems(spec) + code_mismatches(spec)
        if problems:
            return _refused(problems), None
        try:
            candidate = store.get(binding["candidate_digest"])
        except FileNotFoundError:
            return _failed("the committed candidate has not been revealed to the shared artifact store yet"), None
        except ValueError as e:
            return _refused([f"the committed candidate artifact failed its integrity check: {e}"]), None
        repro = spec["reproducibility"]
        attempt = (ver["attempt"] + 1) if ver else 1
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("INSERT INTO verifications(chain_id, contract, challenge_id, submission_id, status, worker_evaluation_id, "
                         "worker_evidence_digest, mode, replays, required, started_at, attempt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) "
                         "ON CONFLICT(chain_id, contract, challenge_id, submission_id) DO UPDATE SET status=excluded.status, "
                         "outcome=NULL, reason=NULL, evidence_digest=NULL, worker_evaluation_id=excluded.worker_evaluation_id, "
                         "worker_evidence_digest=excluded.worker_evidence_digest, mode=excluded.mode, replays=excluded.replays, "
                         "replays_done=0, violated=NULL, required=excluded.required, started_at=excluded.started_at, "
                         "finished_at=NULL, attempt=excluded.attempt",
                         (*k, sid, "verifying", req.evaluation_id, req.evidence_digest, repro["mode"], repro["replays"],
                          repro["required_violations"], now, attempt))
            conn.execute("COMMIT")
        except sqlite3.IntegrityError:
            conn.execute("ROLLBACK")
            return _reply(202, {"status": "waiting", "reason": "another verification for this challenge is running"}), None
        except Exception:
            conn.execute("ROLLBACK")
            raise
        t = threading.Thread(target=self._run, args=(k, sid, attempt, spec, ch["spec_digest"], candidate, binding),
                             name=f"verify-{k[2]}-{sid[:10]}", daemon=True)
        self._threads[k] = t
        t.start()
        ver = _row(conn.execute("SELECT * FROM verifications WHERE chain_id=? AND contract=? AND challenge_id=? AND submission_id=?",
                                (*k, sid)).fetchone())
        return _reply(202, {"status": "verifying", "verification": verification_summary(ver)}), t

    def _finish(self, conn, k: tuple, sid: str, status: str, *, reason: str, attempt: int | None = None,
                outcome: str | None = None, evidence: str | None = None, violated: int | None = None) -> bool:
        """Close a running verification (only the attempt that is still running, if given)."""
        conn.execute("BEGIN IMMEDIATE")
        try:
            cur = conn.execute("UPDATE verifications SET status=?, outcome=?, reason=?, evidence_digest=?, violated=?, finished_at=? "
                               "WHERE chain_id=? AND contract=? AND challenge_id=? AND submission_id=? AND status='verifying' "
                               "AND (? IS NULL OR attempt=?)",
                               (status, outcome, reason[:500], evidence, violated, self.now(), *k, sid, attempt, attempt))
            conn.execute("COMMIT")
            if cur.rowcount == 1:
                log.info("challenge %s: submission %s %s: %s", k[2], sid, status, reason[:300])
            return cur.rowcount == 1
        except Exception:
            conn.execute("ROLLBACK")
            raise

    def _run(self, k: tuple, sid: str, attempt: int, spec: dict, spec_dgst: str, candidate: dict, binding: dict) -> None:
        """Background thread: the signer's own k-of-n replay, then sign or record why not."""
        try:
            self._verify(k, sid, attempt, spec, spec_dgst, candidate, binding)
        except Exception as e:  # never leave a verification "verifying" behind
            with self.lock(k), closing(_db()) as conn:
                self._finish(conn, k, sid, "failed", attempt=attempt,
                             reason=f"verification crashed: {type(e).__name__}: {redact(str(e))[:300]}")

    def _verify(self, k: tuple, sid: str, attempt: int, spec: dict, spec_dgst: str, candidate: dict, binding: dict) -> None:
        store = ArtifactStore()

        def progress(i: int, _rec: dict) -> None:
            with closing(_db()) as c:
                c.execute("UPDATE verifications SET replays_done=? WHERE chain_id=? AND contract=? AND challenge_id=? "
                          "AND submission_id=?", (i + 1, *k, sid))

        log.info("challenge %s: verifying submission %s (attempt %s, %s replays, %s required)", k[2], sid, attempt,
                 spec["reproducibility"]["replays"], spec["reproducibility"]["required_violations"])
        try:
            broker = self.broker_factory(spec)
            client = getattr(broker, "client", None)
            if client is not None:
                client.cancel = self.stop
            with self._slots:
                bundle = evaluate(spec=spec, spec_dgst=spec_dgst, candidate=candidate, submission=binding,
                                  broker=broker, cancel=self.stop, on_replay=progress)
        except MissingCredential as e:
            log.warning("challenge %s: cannot replay: %s", k[2], redact(str(e)))
            with self.lock(k), closing(_db()) as conn:
                self._finish(conn, k, sid, "failed", attempt=attempt,
                             reason=f"the signer cannot replay this live-model target: {redact(str(e))}")
            return
        own = _store_bundle(store, bundle)
        v = bundle["verdict"]
        violated = sum(1 for r in bundle["replays"] if r["claimed_rule_violated"])
        log.info("challenge %s: own replays of %s -> %s (%s); evidence %s", k[2], sid, v["outcome"], v["reason"], own)
        if v["outcome"] in ("runner_failure", "cancelled"):
            with self.lock(k), closing(_db()) as conn:
                self._finish(conn, k, sid, "failed", attempt=attempt, outcome=v["outcome"], evidence=own, violated=violated,
                             reason=f"the signer's replay could not run: {v['reason']}")
            return
        problems = []
        if v["outcome"] != "verified_violation":
            problems.append(f"the signer's own replays did not verify the violation: {v['outcome']} - {v['reason']}")
        elif not v["reward_eligible"]:
            problems.append("the verified violation is not eligible for the reward under the specification")
        else:
            problems += recheck_bundle(bundle, spec)
            problems += _binding_problems(bundle, binding, spec_dgst)
        with self.lock(k), closing(_db()) as conn:
            if problems:
                self._finish(conn, k, sid, "rejected", attempt=attempt, outcome=v["outcome"], evidence=own, violated=violated,
                             reason="; ".join(problems))
                return
            self._sign_verified(conn, k, sid, attempt, spec_dgst, own, binding, violated, v["reason"])

    def _sign_verified(self, conn, k: tuple, sid: str, attempt: int, spec_dgst: str, own: str, binding: dict,
                       violated: int, reason: str) -> None:
        """Called under the challenge lock once the signer's own bundle verified the violation."""
        s = settings()
        mine = conn.execute("SELECT 1 FROM verifications WHERE chain_id=? AND contract=? AND challenge_id=? AND submission_id=? "
                            "AND status='verifying' AND attempt=?", (*k, sid, attempt)).fetchone()
        if mine is None:
            return  # superseded (e.g. marked interrupted and restarted); never sign for a stale attempt
        try:
            ch, sub = self._read_chain(k[2], sid)
        except Exception as e:
            self._finish(conn, k, sid, "failed", attempt=attempt, outcome="verified_violation", evidence=own, violated=violated,
                         reason=f"verified, but the chain could not be re-read before signing: {type(e).__name__}")
            return
        now = self.now()
        problems = self._chain_problems(ch, sub, k[2], spec_dgst, now)
        if not problems and {f: sub[f] for f in ("challenger", "recipient", "candidate_digest")} != \
                {f: binding[f] for f in ("challenger", "recipient", "candidate_digest")}:
            problems.append("the on-chain submission changed during verification")
        expiry = min(now + ATTESTATION_TTL, ch["settlement_deadline"])
        if not problems and expiry <= now:
            problems.append("settlement window has closed")
        prior = _row(conn.execute("SELECT * FROM signed WHERE chain_id=? AND contract=? AND challenge_id=?", k).fetchone())
        if prior and prior["submission_id"].lower() != sid:
            problems.append("this challenge already has an attestation for another submission")
        if problems:
            self._finish(conn, k, sid, "rejected", attempt=attempt, outcome="verified_violation", evidence=own,
                         violated=violated, reason="; ".join(problems))
            return
        message = {"challengeId": int(k[2]), "specDigest": to_bytes32(spec_dgst), "submissionId": sid,
                   "candidateDigest": to_bytes32(binding["candidate_digest"]), "evidenceDigest": to_bytes32(own),
                   "challenger": binding["challenger"], "recipient": binding["recipient"],
                   "verdict": VERDICT_VERIFIED_VIOLATION, "expiry": expiry}
        signature, typed = sign_attestation(self.key, s.chain_id, s.contract, message)
        att_id = "att_" + digest({"typed": typed})[7:23]
        kind = "reverified" if prior else "initial"
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute("UPDATE verifications SET status='verified', outcome='verified_violation', reason=?, evidence_digest=?, "
                         "violated=?, finished_at=?, mac=? WHERE chain_id=? AND contract=? AND challenge_id=? AND submission_id=?",
                         (reason, own, violated, now, self._mac(k, sid, own), *k, sid))
            if prior:
                conn.execute("UPDATE signed SET evidence_digest=?, attestation_id=?, typed_data=?, signature=?, expiry=?, created_at=? "
                             "WHERE chain_id=? AND contract=? AND challenge_id=? AND submission_id=?",
                             (own, att_id, json.dumps(typed), signature, expiry, now, *k, prior["submission_id"]))
            else:
                conn.execute("INSERT INTO signed VALUES (?,?,?,?,?,?,?,?,?,?)",
                             (*k, sid, own, att_id, json.dumps(typed), signature, expiry, now))
            conn.execute("INSERT INTO attestation_history(chain_id, contract, challenge_id, submission_id, attestation_id, "
                         "previous_id, evidence_digest, expiry, kind, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                         (*k, sid, att_id, prior["attestation_id"] if prior else None, own, expiry, kind, now))
            conn.execute("COMMIT")
            log.info("challenge %s: signed %s (%s) for submission %s, expiry %s", k[2], att_id, kind, sid, expiry)
        except sqlite3.IntegrityError:
            conn.execute("ROLLBACK")
            self._finish(conn, k, sid, "rejected", attempt=attempt, outcome="verified_violation", evidence=own,
                         violated=violated, reason="another submission was attested for this challenge first")
        except Exception:
            conn.execute("ROLLBACK")
            raise

    # ------------------------------------------------------------------ repeat / renew
    def _attestation_body(self, conn, k: tuple, signed: dict, own: dict | None, repeated: bool) -> dict:
        last = _row(conn.execute("SELECT kind, previous_id FROM attestation_history WHERE chain_id=? AND contract=? "
                                 "AND challenge_id=? AND attestation_id=? ORDER BY id DESC LIMIT 1",
                                 (*k, signed["attestation_id"])).fetchone())
        return {"status": "signed", "attestation_id": signed["attestation_id"], "typed_data": json.loads(signed["typed_data"]),
                "signature": signed["signature"], "signer": self.me, "expiry": signed["expiry"],
                "evidence_digest": own["evidence_digest"] if own else None, "verification": verification_summary(own),
                "kind": last["kind"] if last else "legacy", "previous_attestation_id": last["previous_id"] if last else None,
                "repeated": repeated}

    def _renew_or_repeat(self, conn, k: tuple, signed: dict, own: dict, ch: dict, binding: dict, now: int,
                         repeat: bool = True) -> JSONResponse:
        s = settings()
        # Only a message this key really signed, backed by a verified row this key MACed, is
        # ever repeated or extended (the caller checked both; checked again here as the gate).
        problems = self._stored_problems(k, signed)
        if not self._mac_ok(k, binding["submission_id"], own) or own["evidence_digest"] != signed["evidence_digest"]:
            problems.append("the signer's verification record for this attestation is not authentic; refusing to renew")
        if problems:
            return _refused(problems)
        store = ArtifactStore()
        typed = json.loads(signed["typed_data"])
        m = typed["message"]
        try:
            spec = store.get(ch["spec_digest"])
            bundle = _load_bundle(store, own["evidence_digest"])
        except FileNotFoundError:
            return _refused(["the signer's stored evidence or specification is missing; refusing to renew"])
        except ValueError as e:
            return _refused([f"the signer's stored evidence failed its integrity check: {e}"])
        problems += self._spec_problems(spec)
        problems += recheck_bundle(bundle, spec)
        if not bundle["verdict"]["reward_eligible"]:
            problems.append("stored evidence is not reward-eligible")
        problems += _binding_problems(bundle, binding, ch["spec_digest"])
        expected = {"challengeId": int(k[2]), "specDigest": to_bytes32(ch["spec_digest"]), "submissionId": binding["submission_id"],
                    "candidateDigest": to_bytes32(binding["candidate_digest"]), "evidenceDigest": to_bytes32(own["evidence_digest"]),
                    "challenger": binding["challenger"], "recipient": binding["recipient"], "verdict": VERDICT_VERIFIED_VIOLATION}
        if {f: m.get(f) for f in expected} != expected:
            problems.append("the stored attestation no longer matches the on-chain binding")
        if typed["domain"] != domain(s.chain_id, s.contract):
            problems.append("the stored attestation is for a different chain or contract")
        if problems:
            log.warning("challenge %s: refusing to repeat or renew: %s", k[2], "; ".join(problems))
            return _refused(problems)
        if signed["expiry"] - now > RENEW_MARGIN:
            return _reply(200, self._attestation_body(conn, k, signed, own, repeated=repeat))
        expiry = min(now + ATTESTATION_TTL, ch["settlement_deadline"])
        if expiry <= now:
            return _refused(["settlement window has closed"])
        if expiry <= signed["expiry"]:
            # Already capped at the settlement deadline: nothing later can be signed.
            return _reply(200, self._attestation_body(conn, k, signed, own, repeated=repeat))
        signature, new_typed = sign_attestation(self.key, s.chain_id, s.contract, dict(m, expiry=expiry))
        att_id = "att_" + digest({"typed": new_typed})[7:23]
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute("UPDATE signed SET attestation_id=?, typed_data=?, signature=?, expiry=?, created_at=? "
                         "WHERE chain_id=? AND contract=? AND challenge_id=?",
                         (att_id, json.dumps(new_typed), signature, expiry, now, *k))
            conn.execute("INSERT INTO attestation_history(chain_id, contract, challenge_id, submission_id, attestation_id, "
                         "previous_id, evidence_digest, expiry, kind, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                         (*k, binding["submission_id"], att_id, signed["attestation_id"], own["evidence_digest"], expiry,
                          "renewal", now))
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        log.info("challenge %s: renewed %s as %s (expiry %s -> %s)", k[2], signed["attestation_id"], att_id, signed["expiry"], expiry)
        signed = _row(conn.execute("SELECT * FROM signed WHERE chain_id=? AND contract=? AND challenge_id=?", k).fetchone())
        return _reply(200, self._attestation_body(conn, k, signed, own, repeated=False))


def create_app(clock: Callable[[], float] | None = None, broker_factory: Callable[[dict], object] | None = None,
               sync_wait: float = SYNC_WAIT) -> FastAPI:
    """`clock` and `broker_factory` are injectable for tests (controlled time, scripted models)."""
    os.environ.setdefault("COUNTERPROOF_ROLE", "signer")
    token = settings().signer_token  # loads .env (signer role) before the keys are read
    key = os.environ.get("EVALUATOR_PRIVATE_KEY")
    _init_db()
    verifier = Verifier(key, clock or time.time, broker_factory or (lambda spec: broker_for_spec(spec, None)), sync_wait)
    app = FastAPI(title="CounterProof evaluator signer", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.verifier = verifier

    def auth(authorization: str | None = Header(default=None)) -> None:
        if token and not hmac.compare_digest(authorization or "", f"Bearer {token}"):
            raise HTTPException(401, "unauthorised")

    @app.get("/health")
    def health() -> dict:
        return {"configured": bool(key), "address": verifier.me, "network": settings().network, "contract": settings().contract}

    @app.post("/attest", dependencies=[Depends(auth)])
    def attest(req: AttestRequest) -> JSONResponse:
        return verifier.attest(req)

    return app


def main() -> None:
    import uvicorn

    port = int(os.environ.get("COUNTERPROOF_SIGNER_PORT", "8011"))
    uvicorn.run(create_app(), host="127.0.0.1", port=port, log_level="info")


if __name__ == "__main__":
    main()
