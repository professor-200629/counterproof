"""Server-side limits on what a caller can make the evaluator spend.

* Role caps (judge / operator) on run budgets and parameters. Caller values are clamped to the
  cap; an absent or 0 model budget never means "unlimited" (the harness treats 0 as
  unlimited, so 0 is replaced before a Budget is built).
* Queue capacity: a per-session limit on active jobs and a global limit on queued + running
  jobs (429), and the operator stop (503).
* A model-token ledger (one row per successful model call) with a per-session daily budget and a
  global daily ceiling, checked by every model client before each call. A refusal is raised as
  ProviderError(kind="unavailable") by the caller - a provider-side failure, so the runner
  records runner_failure (retryable, never a verdict). It must never be kind "budget": the
  runner maps that to target_crash, which would blame the target.

Every number comes from the environment with a safe default; see .env.example.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from dataclasses import asdict, dataclass

ROLES = ("judge", "operator")

# Every non-secret setting read here or by auth.py. Launchers (scripts/dev.py, the e2e Stack)
# strip secret-looking names from child environments ("TOKEN" is in several of these), so they
# forward exactly these names from the environment and .env to the API and worker processes.
FORWARDED_SETTINGS = tuple(
    [f"COUNTERPROOF_{r}_{f}" for r in ("JUDGE", "OPERATOR")
     for f in ("MAX_SEQUENCES", "MAX_WALL_SECONDS", "MAX_MODEL_CALLS", "MAX_MODEL_TOKENS", "MAX_ACTIONS",
               "MAX_ACTIVE_JOBS", "DAILY_TOKENS")]
    + ["COUNTERPROOF_MAX_QUEUED_JOBS", "COUNTERPROOF_DAILY_TOKEN_CEILING", "COUNTERPROOF_ALLOWED_ORIGINS",
       "COUNTERPROOF_ALLOWED_HOSTS", "COUNTERPROOF_COOKIE_SECURE", "COUNTERPROOF_SESSION_HOURS"])


# ---------------------------------------------------------------------------- configuration
def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return max(0, int(raw))
    except ValueError:
        return default


@dataclass(frozen=True)
class RoleCaps:
    max_sequences: int
    max_wall_seconds: int
    max_model_calls: int
    max_model_tokens: int
    max_actions: int              # spec scope.max_actions and the max_length run parameter
    max_sequences_per_call: int   # model-assisted generator
    max_active_jobs: int          # queued + running jobs per session; 0 = no per-session limit
    daily_tokens: int             # model tokens per session per UTC day; 0 = no per-session limit

    def as_dict(self) -> dict:
        return asdict(self)


def caps(role: str) -> RoleCaps:
    if role == "operator":
        p = "COUNTERPROOF_OPERATOR_"
        return RoleCaps(
            max_sequences=_env_int(p + "MAX_SEQUENCES", 100_000),
            max_wall_seconds=_env_int(p + "MAX_WALL_SECONDS", 3_600),
            max_model_calls=_env_int(p + "MAX_MODEL_CALLS", 400),
            max_model_tokens=_env_int(p + "MAX_MODEL_TOKENS", 600_000),
            max_actions=32,
            max_sequences_per_call=10,
            max_active_jobs=_env_int(p + "MAX_ACTIVE_JOBS", 0),
            daily_tokens=_env_int(p + "DAILY_TOKENS", 0),
        )
    p = "COUNTERPROOF_JUDGE_"
    return RoleCaps(
        max_sequences=_env_int(p + "MAX_SEQUENCES", 50),
        max_wall_seconds=_env_int(p + "MAX_WALL_SECONDS", 300),
        max_model_calls=_env_int(p + "MAX_MODEL_CALLS", 60),
        max_model_tokens=_env_int(p + "MAX_MODEL_TOKENS", 60_000),
        max_actions=min(_env_int(p + "MAX_ACTIONS", 8), 32),
        max_sequences_per_call=5,
        max_active_jobs=_env_int(p + "MAX_ACTIVE_JOBS", 2),
        daily_tokens=_env_int(p + "DAILY_TOKENS", 200_000),
    )


def max_queued_jobs() -> int:
    """Global limit on queued + running jobs, whoever queued them."""
    return _env_int("COUNTERPROOF_MAX_QUEUED_JOBS", 20)


def daily_token_ceiling() -> int:
    """Global model-token ceiling per UTC day, across every session and script."""
    return _env_int("COUNTERPROOF_DAILY_TOKEN_CEILING", 1_000_000)


def role_of(owner: str | None) -> str:
    """Owner strings are "operator" or "<role>:<handle>". Rows from before authentication
    (owner NULL) were queued by trusted scripts and get the operator caps (still finite)."""
    if not owner or owner == "operator":
        return "operator"
    role = owner.split(":", 1)[0]
    return role if role in ROLES else "judge"


class LimitError(Exception):
    """Refused by a server-side limit. status: 403 (role), 429 (capacity), 503 (operator stop)."""

    def __init__(self, message: str, status: int = 429):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------------------- budgets & params
RUN_DEFAULTS = {"max_sequences": 120, "max_wall_seconds": 90}
MODEL_RUN_DEFAULTS = {"max_sequences": 12, "max_wall_seconds": 900, "max_model_calls": 80, "max_model_tokens": 120_000}
_BUDGET_INTS = ("max_sequences", "max_wall_seconds", "max_model_calls", "max_model_tokens")


def _as_int(field: str, v) -> int:
    if isinstance(v, bool):
        raise LimitError(f"budget.{field} must be an integer", 400)
    try:
        return int(v)
    except (TypeError, ValueError):
        raise LimitError(f"budget.{field} must be an integer", 400) from None


def clamp_budget(requested: dict | None, role: str, model_involved: bool) -> tuple[dict, dict]:
    """The effective budget for a run, and what was clamped ({field: {requested, effective}}).

    Only the harness's budget fields are kept. max_sequences / max_wall_seconds are clamped
    to [0, cap] (0 means "run nothing", never "unlimited"). The model budget is always present
    and positive: absent or <= 0 takes the default, then the cap."""
    req = dict(requested or {})
    c = caps(role)
    cap = {"max_sequences": c.max_sequences, "max_wall_seconds": c.max_wall_seconds,
           "max_model_calls": c.max_model_calls, "max_model_tokens": c.max_model_tokens}
    defaults = dict(MODEL_RUN_DEFAULTS if model_involved else RUN_DEFAULTS)
    defaults.setdefault("max_model_calls", MODEL_RUN_DEFAULTS["max_model_calls"])
    defaults.setdefault("max_model_tokens", MODEL_RUN_DEFAULTS["max_model_tokens"])
    out: dict = {}
    clamped: dict = {}
    for f in _BUDGET_INTS:
        has = f in req and req[f] is not None
        v = _as_int(f, req[f]) if has else defaults[f]
        if f in ("max_model_calls", "max_model_tokens") and v <= 0:
            v = defaults[f]
        v = max(0, min(v, cap[f]))
        out[f] = v
        if has and _as_int(f, req[f]) != v:
            clamped[f] = {"requested": req[f], "effective": v}
    if "shrink" in req:
        out["shrink"] = bool(req["shrink"])
    return out, clamped


def clamp_params(params: dict, role: str, scope_max_actions: int) -> dict:
    """Bound the run parameters a strategy reads (max_length, sequences_per_call, seed)."""
    p = dict(params or {})
    c = caps(role)
    if "max_length" in p:
        p["max_length"] = max(1, min(_as_param_int("max_length", p["max_length"]), scope_max_actions, c.max_actions))
    if "sequences_per_call" in p:
        p["sequences_per_call"] = max(1, min(_as_param_int("sequences_per_call", p["sequences_per_call"]),
                                             c.max_sequences_per_call))
    if "seed" in p:
        p["seed"] = _as_param_int("seed", p["seed"])
    return p


def _as_param_int(field: str, v) -> int:
    if isinstance(v, bool):
        raise LimitError(f"params.{field} must be an integer", 400)
    try:
        return int(v)
    except (TypeError, ValueError):
        raise LimitError(f"params.{field} must be an integer", 400) from None


def configured_model() -> tuple[str, str]:
    """The provider/model a judge's runs and specs are fixed to."""
    from .config import settings
    from .providers import PROVIDERS

    s = settings()
    provider = s.llm_provider or "groq"
    return provider, s.llm_model or PROVIDERS.get(provider, {}).get("default_model", "")


JUDGE_MAX_STEPS = 8
_TARGET_CONFIG_KEYS = {"provider", "model", "temperature", "max_steps"}


def judge_target_config(given: dict | None, requires_model: bool) -> dict:
    """A judge's spec target_config: the configured provider/model, temperature 0 and at most
    8 agent steps. Anything else is refused (403) rather than silently changed."""
    given = dict(given or {})
    if not requires_model:
        if given:
            raise LimitError("judge sessions cannot set target_config on a deterministic target", 403)
        return {}
    extra = set(given) - _TARGET_CONFIG_KEYS
    if extra:
        raise LimitError(f"judge sessions cannot set target_config fields {sorted(extra)}", 403)
    provider, model = configured_model()
    if given.get("provider", provider) != provider or given.get("model", model) != model:
        raise LimitError(f"judge sessions use the configured model {provider}/{model}; "
                         f"{given.get('provider', provider)}/{given.get('model', model)} needs the operator", 403)
    try:
        temperature = float(given.get("temperature", 0))
        steps = int(given.get("max_steps", JUDGE_MAX_STEPS))
    except (TypeError, ValueError):
        raise LimitError("target_config temperature and max_steps must be numbers", 400) from None
    if temperature != 0:
        raise LimitError("judge sessions run the model at temperature 0", 403)
    if steps < 1 or steps > JUDGE_MAX_STEPS:
        raise LimitError(f"judge sessions allow max_steps between 1 and {JUDGE_MAX_STEPS}", 403)
    return {"provider": provider, "model": model, "temperature": 0, "max_steps": steps}


def judge_run_model(params: dict) -> dict:
    """Model-assisted run parameters for a judge: the configured provider/model only."""
    p = dict(params or {})
    provider, model = configured_model()
    if p.get("provider", provider) != provider or p.get("model", model) != model:
        raise LimitError(f"judge sessions use the configured model {provider}/{model} for model-assisted runs", 403)
    p["provider"], p["model"] = provider, model
    return p


# ---------------------------------------------------------------------------- shared state (main DB)
_DDL = (
    "CREATE TABLE IF NOT EXISTS model_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, owner TEXT, "
    "job_id TEXT, provider TEXT NOT NULL, model TEXT NOT NULL, prompt_tokens INTEGER NOT NULL, "
    "completion_tokens INTEGER NOT NULL, created_at INTEGER NOT NULL)",
    "CREATE INDEX IF NOT EXISTS model_usage_day_owner ON model_usage(day, owner)",
    "CREATE TABLE IF NOT EXISTS operator_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
)


def ensure_tables(conn: sqlite3.Connection) -> None:
    for stmt in _DDL:
        conn.execute(stmt)


def _connect() -> sqlite3.Connection:
    from .db import connect

    conn = connect()
    ensure_tables(conn)
    return conn


def today() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


def tokens_today(conn: sqlite3.Connection, owner: str | None = None) -> int:
    """Model tokens used today (UTC): by one owner, or by everyone when owner is None."""
    ensure_tables(conn)
    if owner is None:
        r = conn.execute("SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) FROM model_usage WHERE day=?",
                         (today(),)).fetchone()
    else:
        r = conn.execute("SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) FROM model_usage WHERE day=? AND owner=?",
                         (today(), owner)).fetchone()
    return int(r[0])


def stop_state(conn: sqlite3.Connection) -> dict | None:
    """The operator stop in effect, or None."""
    ensure_tables(conn)
    r = conn.execute("SELECT value FROM operator_state WHERE key='stop'").fetchone()
    if r is None:
        return None
    try:
        v = json.loads(r[0])
    except ValueError:
        return {"reason": "unreadable stop record"}  # fail closed: a stop that cannot be read stays a stop
    return v if v.get("active") else None


def set_stop(conn: sqlite3.Connection, active: bool, by: str, reason: str = "") -> dict:
    ensure_tables(conn)
    v = {"active": active, "by": by, "reason": reason[:200], "at": int(time.time())}
    conn.execute("INSERT INTO operator_state(key, value, updated_at) VALUES ('stop', ?, ?) "
                 "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                 (json.dumps(v), v["at"]))
    return v


STOP_MESSAGE = "operator stop in effect: no new jobs or model calls until the operator resumes"


def ceiling_refusal(conn: sqlite3.Connection, owner: str | None) -> str | None:
    """Why a model call or a model-using job is refused now (stop, global or session budget), or None."""
    if stop_state(conn):
        return STOP_MESSAGE
    used = tokens_today(conn)
    ceiling = daily_token_ceiling()
    if used >= ceiling:
        return f"cost ceiling reached: {used} of {ceiling} model tokens used today (UTC); resets at 00:00 UTC"
    if owner:
        per = caps(role_of(owner)).daily_tokens
        if per:
            mine = tokens_today(conn, owner)
            if mine >= per:
                return f"cost ceiling reached for this session: {mine} of {per} model tokens used today (UTC)"
    return None


def guard_model_call(owner: str | None) -> str | None:
    """Called by every model client before each provider request; a reason means refuse."""
    conn = _connect()
    try:
        return ceiling_refusal(conn, owner)
    finally:
        conn.close()


def record_usage(owner: str | None, job_id: str | None, provider: str, model: str,
                 prompt_tokens: int, completion_tokens: int) -> None:
    conn = _connect()
    try:
        conn.execute("INSERT INTO model_usage(day, owner, job_id, provider, model, prompt_tokens, completion_tokens, created_at) "
                     "VALUES (?,?,?,?,?,?,?,?)", (today(), owner, job_id, provider, model, int(prompt_tokens),
                                                  int(completion_tokens), int(time.time())))
    finally:
        conn.close()


# ---------------------------------------------------------------------------- queue capacity
ACTIVE = ("queued", "running")


def check_capacity(conn: sqlite3.Connection, owner: str, model_involved: bool = False) -> None:
    """Refuse a new job (raise LimitError) when the operator stop is in effect (503), the
    queue is full (429), this session already has its active jobs (429), or a model-using job
    would start past a token ceiling (429). Call inside the transaction that enqueues."""
    if stop_state(conn):
        raise LimitError(STOP_MESSAGE, 503)
    total = conn.execute("SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')").fetchone()[0]
    if total >= max_queued_jobs():
        raise LimitError(f"the evaluator queue is full ({total} jobs queued or running, limit {max_queued_jobs()}); "
                         "try again when some finish", 429)
    per = caps(role_of(owner)).max_active_jobs
    if per and owner != "operator":
        mine = conn.execute("SELECT COUNT(*) FROM jobs WHERE owner=? AND status IN ('queued','running')",
                            (owner,)).fetchone()[0]
        if mine >= per:
            raise LimitError(f"this session already has {mine} active jobs (limit {per}); wait for one to finish "
                             "or cancel it", 429)
    if model_involved:
        why = ceiling_refusal(conn, owner)
        if why:
            raise LimitError(why, 429)


def usage_view(conn: sqlite3.Connection, owner: str | None, role: str) -> dict:
    c = caps(role)
    mine = tokens_today(conn, owner) if owner else 0
    active = conn.execute("SELECT COUNT(*) FROM jobs WHERE owner=? AND status IN ('queued','running')",
                          (owner,)).fetchone()[0] if owner else 0
    used = tokens_today(conn)
    return {"active_jobs": active, "max_active_jobs": c.max_active_jobs or None,
            "tokens_today": mine, "daily_tokens": c.daily_tokens or None,
            "tokens_remaining": max(0, c.daily_tokens - mine) if c.daily_tokens else None,
            "global_tokens_today": used, "global_daily_ceiling": daily_token_ceiling(),
            "day": today()}
