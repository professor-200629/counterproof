"""Who may change anything: the operator and time-limited judge sessions.

This is a demo gate, not an account system:

* operator - scripts and the owner. ``Authorization: Bearer <COUNTERPROOF_OPERATOR_TOKEN>``.
  Bearer requests carry no ambient credential, so they need no CSRF token.
* judge - ``POST /api/session {"passcode": COUNTERPROOF_JUDGE_PASSCODE}`` returns a random
  session id in an HttpOnly, SameSite=Strict cookie (Path=/api) and a CSRF token. The server
  keeps only the SHA-256 of the id (table ``sessions``), with an expiry (8 h by default). Entering
  the operator token as the passcode opens an operator cookie session.

Cookie-authenticated mutations also need ``X-CSRF-Token`` equal to the session's token and an
Origin (or Referer) listed in COUNTERPROOF_ALLOWED_ORIGINS. CORS is not authentication.

If neither secret is configured every mutation is refused (fail closed). A secret shorter than
its minimum (operator token 24 characters, judge passcode 12) is ignored, as if unset: guessing
is stopped by the secrets' length, not by the attempt limiter. Behind the Next.js /api proxy
every browser reaches the API from 127.0.0.1 with no X-Forwarded-For, so the limiter cannot
tell clients apart there; it slows failed attempts but never refuses the correct passcode,
otherwise anyone could keep every judge locked out.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import sqlite3
import threading
import time
from collections import deque
from dataclasses import dataclass
from urllib.parse import urlsplit

from .db import new_id, now

COOKIE = "cp_session"
CSRF_HEADER = "X-CSRF-Token"
SESSION_SECONDS_DEFAULT = 8 * 3600
NOT_CONFIGURED = ("changes are disabled: this evaluator has no COUNTERPROOF_OPERATOR_TOKEN or COUNTERPROOF_JUDGE_PASSCODE "
                  "configured. Set them on the API process (scripts/dev.py generates an operator token for each launch).")
SIGN_IN = "sign in first: judges use the passcode (Judge sign-in), scripts send Authorization: Bearer <operator token>"


class AuthError(Exception):
    def __init__(self, message: str, status: int = 401, headers: dict | None = None):
        super().__init__(message)
        self.status = status
        self.headers = headers or {}


@dataclass(frozen=True)
class Actor:
    role: str            # judge | operator
    owner: str           # "operator" or "<role>:<session handle>", recorded on queued work
    via: str             # bearer | cookie
    expires_at: int | None = None
    csrf_token: str | None = None

    @property
    def is_operator(self) -> bool:
        return self.role == "operator"


# ---------------------------------------------------------------------------- configuration
# Minimum lengths. scripts/dev.py generates 43 and 12 random URL-safe characters (256 and 72
# bits). The bearer token is checked on every request with no attempt limit, so it must be long.
MIN_OPERATOR_TOKEN_CHARS = 24
MIN_PASSCODE_CHARS = 12
_SECRETS = (("COUNTERPROOF_OPERATOR_TOKEN", MIN_OPERATOR_TOKEN_CHARS), ("COUNTERPROOF_JUDGE_PASSCODE", MIN_PASSCODE_CHARS))


def _secret(name: str, minimum: int) -> str | None:
    v = os.environ.get(name) or None
    return v if v is not None and len(v) >= minimum else None


def operator_token() -> str | None:
    return _secret("COUNTERPROOF_OPERATOR_TOKEN", MIN_OPERATOR_TOKEN_CHARS)


def judge_passcode() -> str | None:
    return _secret("COUNTERPROOF_JUDGE_PASSCODE", MIN_PASSCODE_CHARS)


def weak_secrets() -> list[str]:
    """Configured secrets that are too short and therefore ignored (names only, never values)."""
    return [f"{name} is shorter than {minimum} characters and is ignored"
            for name, minimum in _SECRETS if os.environ.get(name) and len(os.environ[name]) < minimum]


def configured() -> bool:
    return bool(operator_token() or judge_passcode())


def not_configured_message() -> str:
    weak = weak_secrets()
    return NOT_CONFIGURED + (" " + "; ".join(weak) + "." if weak else "")


def session_seconds() -> int:
    try:
        return max(60, int(os.environ.get("COUNTERPROOF_SESSION_HOURS", "8")) * 3600)
    except ValueError:
        return SESSION_SECONDS_DEFAULT


def cookie_secure() -> bool:
    return os.environ.get("COUNTERPROOF_COOKIE_SECURE") == "1"


def _csv(name: str, default: str) -> list[str]:
    return [x.strip() for x in os.environ.get(name, default).split(",") if x.strip()]


def allowed_origins() -> list[str]:
    return [o.rstrip("/").lower() for o in _csv("COUNTERPROOF_ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000")]


def allowed_hosts() -> list[str]:
    """Host names (no port) the API answers for; 'testserver' is the test client's."""
    return ["127.0.0.1", "localhost", "testserver"] + [h.lower() for h in _csv("COUNTERPROOF_ALLOWED_HOSTS", "")]


def _eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def _hash(session_id: str) -> str:
    return hashlib.sha256(session_id.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------- sessions
def create_session(conn: sqlite3.Connection, role: str) -> tuple[str, dict]:
    """A new session; returns (cookie value, row). Only the hash of the cookie value is stored."""
    sid = secrets.token_urlsafe(32)
    t = now()
    rec = {"id_hash": _hash(sid), "role": role, "owner": f"{role}:{new_id('sess')}",
           "csrf_token": secrets.token_urlsafe(32), "created_at": t, "expires_at": t + session_seconds(), "revoked": 0}
    conn.execute("DELETE FROM sessions WHERE expires_at < ?", (t - 86400,))
    conn.execute("INSERT INTO sessions(id_hash, role, owner, csrf_token, created_at, expires_at, revoked) VALUES (?,?,?,?,?,?,?)",
                 tuple(rec.values()))
    return sid, rec


def lookup_session(conn: sqlite3.Connection, sid: str | None) -> dict | None:
    if not sid or len(sid) > 200:
        return None
    r = conn.execute("SELECT * FROM sessions WHERE id_hash=?", (_hash(sid),)).fetchone()
    if r is None or r["revoked"] or r["expires_at"] <= now():
        return None
    return dict(r)


def revoke_session(conn: sqlite3.Connection, sid: str | None) -> bool:
    if not sid:
        return False
    return conn.execute("UPDATE sessions SET revoked=1 WHERE id_hash=?", (_hash(sid),)).rowcount > 0


def actor_from_session(rec: dict) -> Actor:
    return Actor(role=rec["role"], owner=rec["owner"], via="cookie", expires_at=rec["expires_at"],
                 csrf_token=rec["csrf_token"])


def cookie_kwargs(max_age: int) -> dict:
    return {"key": COOKIE, "max_age": max_age, "path": "/api", "httponly": True, "samesite": "strict",
            "secure": cookie_secure()}


# ---------------------------------------------------------------------------- passcode attempts
class AttemptLimiter:
    """Failed sign-in attempts: at most `per_client` per client and `overall` in total within
    `window` seconds (see sign_in for what happens past them)."""

    def __init__(self, per_client: int = 5, overall: int = 30, window: float = 60.0):
        self.per_client, self.overall, self.window = per_client, overall, window
        self._lock = threading.Lock()
        self._by: dict[str, deque] = {}
        self._all: deque = deque()

    def _trim(self, q: deque, t: float) -> None:
        while q and q[0] <= t - self.window:
            q.popleft()

    def retry_after(self, client: str, overall: bool = True) -> int:
        """Seconds until this client may try again (0 = allowed now); `overall=False` asks
        about the client's own bucket only."""
        t = time.monotonic()
        with self._lock:
            q = self._by.get(client, deque())
            self._trim(q, t)
            self._trim(self._all, t)
            waits = []
            if len(q) >= self.per_client:
                waits.append(q[0] + self.window - t)
            if overall and len(self._all) >= self.overall:
                waits.append(self._all[0] + self.window - t)
            return int(max(waits) + 1) if waits else 0

    def failed(self, client: str) -> None:
        t = time.monotonic()
        with self._lock:
            self._by.setdefault(client, deque()).append(t)
            self._all.append(t)
            if len(self._by) > 10_000:  # bounded memory
                self._by = {k: v for k, v in self._by.items() if v and v[-1] > t - self.window}

    def reset(self) -> None:
        with self._lock:
            self._by.clear()
            self._all.clear()


LIMITER = AttemptLimiter()


LOOPBACK = ("127.0.0.1", "::1", "localhost", "testclient")


def trusted_proxy() -> bool:
    """COUNTERPROOF_TRUSTED_PROXY=1: a reverse proxy in front of the API appends the real
    client address to X-Forwarded-For. The Next.js /api rewrite does NOT (it sets only
    X-Forwarded-Host), so leave this off behind it."""
    return os.environ.get("COUNTERPROOF_TRUSTED_PROXY") == "1"


@dataclass(frozen=True)
class Client:
    key: str        # the bucket failed sign-ins are counted in
    distinct: bool  # True when the key tells one client from another


def client_of(peer: str | None, forwarded_for: str | None) -> Client:
    """Who is signing in. The TCP peer, except behind a trusted proxy (COUNTERPROOF_TRUSTED_PROXY=1,
    loopback peer), where it is the rightmost X-Forwarded-For entry: the one that proxy added
    (anything to its left came from the client and is forgeable). Without a trusted proxy a
    loopback peer is shared by every browser behind the local Next.js server, and any
    X-Forwarded-For is the client's own invention, so it is ignored."""
    peer = peer or "unknown"
    if peer in LOOPBACK:
        if trusted_proxy() and forwarded_for:
            hop = forwarded_for.split(",")[-1].strip()[:64]
            if hop:
                return Client(hop, True)
        return Client(peer, False)
    return Client(peer, True)


def client_key(peer: str | None, forwarded_for: str | None) -> str:
    return client_of(peer, forwarded_for).key


def sign_in(conn: sqlite3.Connection, passcode: str, client: Client | str) -> tuple[str, dict]:
    """Check a passcode (judge passcode, or the operator token) and open a session.

    Failed attempts are counted per client and overall; past either limit a wrong passcode is
    answered 429 instead of 401. A client that can be told apart (behind a trusted proxy) is
    refused for its window before its passcode is even compared. A shared client (every browser
    behind the Next.js proxy) is not: the correct passcode is always accepted, so nobody can
    hold sign-in closed for everyone by failing on purpose. The overall limit never refuses the
    correct passcode either. What stops guessing is the passcode's length (MIN_PASSCODE_CHARS)."""
    if isinstance(client, str):
        client = Client(client, client not in LOOPBACK)
    if not configured():
        raise AuthError(not_configured_message(), 401)
    if client.distinct:
        wait = LIMITER.retry_after(client.key, overall=False)
        if wait:
            raise AuthError(f"too many failed sign-in attempts; try again in {wait} s", 429, {"Retry-After": str(wait)})
    passcode = passcode or ""
    role = None
    judge, op = judge_passcode(), operator_token()
    # Both comparisons always run, so timing does not reveal which secret matched.
    judge_ok = bool(judge) and _eq(passcode, judge or "")
    op_ok = bool(op) and _eq(passcode, op or "")
    if judge_ok:
        role = "judge"
    if op_ok:
        role = "operator"
    if role is not None:
        return create_session(conn, role)
    wait = LIMITER.retry_after(client.key)
    LIMITER.failed(client.key)
    if wait:
        raise AuthError(f"too many failed sign-in attempts; try again in {wait} s", 429, {"Retry-After": str(wait)})
    weak = [w for w in weak_secrets() if "PASSCODE" in w]
    raise AuthError("wrong passcode" + (f" (judge sign-in is disabled: {weak[0]})" if weak else ""), 401)


# ---------------------------------------------------------------------------- request checks
def origin_of(headers) -> str | None:
    origin = headers.get("origin")
    if origin and origin != "null":
        return origin.rstrip("/").lower()
    ref = headers.get("referer")
    if ref:
        u = urlsplit(ref)
        if u.scheme and u.netloc:
            return f"{u.scheme}://{u.netloc}".lower()
    return None


def authenticate(conn: sqlite3.Connection, headers, cookies) -> Actor:
    """The actor behind a mutating request, or AuthError (401 / 403)."""
    if not configured():
        raise AuthError(not_configured_message(), 401)
    auth = headers.get("authorization")
    if auth:
        scheme, _, value = auth.partition(" ")
        op = operator_token()
        if scheme.lower() == "bearer" and op and value and _eq(value.strip(), op):
            return Actor(role="operator", owner="operator", via="bearer")
        weak = [w for w in weak_secrets() if "OPERATOR" in w]
        raise AuthError("invalid operator token" + (f" ({weak[0]})" if weak else ""), 401)
    rec = lookup_session(conn, cookies.get(COOKIE))
    if rec is None:
        raise AuthError(SIGN_IN if not cookies.get(COOKIE) else "your session has expired or was signed out; sign in again", 401)
    sent = headers.get(CSRF_HEADER.lower()) or ""
    if not sent or not _eq(sent, rec["csrf_token"]):
        raise AuthError("missing or wrong X-CSRF-Token for this session (reload the page)", 403)
    origin = origin_of(headers)
    if origin is None or origin not in allowed_origins():
        raise AuthError(f"origin {origin or '(none)'} is not allowed to change anything here "
                        "(COUNTERPROOF_ALLOWED_ORIGINS)", 403)
    return actor_from_session(rec)


def host_allowed(host_header: str | None) -> bool:
    """Host / X-Forwarded-Host check (DNS rebinding): the name must be an allowed host."""
    if not host_header:
        return True
    host = host_header.strip().lower()
    if host.startswith("["):  # IPv6 literal
        name = host[1:host.find("]")] if "]" in host else host
    else:
        name = host.rsplit(":", 1)[0] if host.count(":") == 1 else host
    allowed = allowed_hosts()
    return "*" in allowed or name in allowed or name in ("::1",)
