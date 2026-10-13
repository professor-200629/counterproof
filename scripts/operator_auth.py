"""Operator credentials for scripts that call the CounterProof API.

The API refuses every change without credentials (backend/counterproof/auth.py). Scripts act
as the operator: ``Authorization: Bearer <COUNTERPROOF_OPERATOR_TOKEN>``. The token comes from
the environment, else from data/operator.token, which scripts/dev.py writes for each launch
(data/ is git-ignored). The token is never printed.

(This module is not named operator.py: that name is the stdlib ``operator`` module.)
"""

from __future__ import annotations

import os
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
TOKEN_FILE = ROOT / "data" / "operator.token"
ENV = "COUNTERPROOF_OPERATOR_TOKEN"


def token() -> str | None:
    t = os.environ.get(ENV)
    if t:
        return t.strip()
    try:
        return TOKEN_FILE.read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def headers() -> dict[str, str]:
    t = token()
    return {"Authorization": f"Bearer {t}"} if t else {}


def require_headers() -> dict[str, str]:
    h = headers()
    if not h:
        raise SystemExit(f"no operator token: set {ENV} or start the stack with scripts/dev.py (writes {TOKEN_FILE.relative_to(ROOT)})")
    return h


def client(base_url: str, timeout: float = 60) -> httpx.Client:
    """An HTTP client for the API that authenticates as the operator."""
    return httpx.Client(base_url=base_url, timeout=timeout, headers=headers())


def write_token_file(value: str) -> Path:
    """dev.py: store this launch's token for local scripts (owner-readable where supported)."""
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_FILE.write_text(value, encoding="utf-8")
    try:
        os.chmod(TOKEN_FILE, 0o600)
    except OSError:
        pass
    return TOKEN_FILE
