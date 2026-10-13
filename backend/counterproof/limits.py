"""Server-side limits on what a caller can make the evaluator spend.

* Role caps (judge / operator) on run budgets and parameters. Caller values are clamped to the
  cap; an absent or 0 model budget never means "unlimited" (the harness treats 0 as
  unlimited, so 0 is replaced before a Budget is built).
* Queue capacity: a per-session limit on active jobs, a limit on the active jobs of all judge
  sessions together, and a global limit on queued + running jobs (429), and the operator stop
  (503).
* A model-token ledger (one row per successful model call) with a per-session daily budget, a
  daily budget for all judge sessions together and a global daily ceiling, checked by every
  model client before each call - the worker's and the signer's (owner "signer"). A refusal is
  raised as ProviderError(kind="unavailable") by the caller - a provider-side failure, so the
  runner records runner_failure (retryable, never a verdict; the signer answers "failed,
  retryable", never a refusal). It must never be kind "budget": the runner maps that to
  target_crash, which would blame the target.

Per-session limits are not per person: whoever holds the passcode can sign in again for a new
session. The judge-wide limits are what bound all judges together, and they sit below the
global queue limit and token ceiling so the operator's own work always keeps headroom.

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
    + ["COUNTERPROOF_JUDGE_TOTAL_ACTIVE_JOBS", "COUNTERPROOF_JUDGE_TOTAL_DAILY_TOKENS",
       "COUNTERPROOF_MAX_QUEUED_JOBS", "COUNTERPROOF_DAILY_TOKEN_CEILING", "COUNTERPROOF_ALLOWED_ORIGINS",
       "COUNTERPROOF_ALLOWED_HOSTS", "COUNTERPROOF_COOKIE_SECURE", "COUNTERPROOF_SESSION_HOURS",
       "COUNTERPROOF_TRUSTED_PROXY"])


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
    # Every session of this role together (signing in again opens a new session with fresh
    # per-session quotas, so these are what bound the role); 0 = no role-wide limit.
    all_sessions_active_jobs: int = 0
    all_sessions_daily_tokens: int = 0

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
        # Below the global queue limit (20) and token ceiling (1,000,000): judges together can
        # never fill the queue or spend the day's ceiling, so the operator keeps headroom.
        all_sessions_active_jobs=_env_int(p + "TOTAL_ACTIVE_JOBS", 8),
        all_sessions_daily_tokens=_env_int(p + "TOTAL_DAILY_TOKENS", 500_000),
    )


def max_queued_jobs() -> int:
    """Global limit on queued + running jobs, whoever queued them."""
    return _env_int("COUNTERPROOF_MAX_QUEUED_JOBS", 20)


def daily_token_ceiling() -> int:
    """Global model-token ceiling per UTC day, across every session and script."""
    return _env_int("COUNTERPROOF_DAILY_TOKEN_CEILING", 1_000_000)


SYSTEM_OWNERS = ("operator", "signer")  # the signer's own replays are attributed to "signer"


def role_of(owner: str | None) -> str:
    """Owner strings are "operator", "signer" or "<role>:<handle>". Rows from before
    authentication (owner NULL) were queued by trusted scripts and get the operator caps (still
    finite). Anything unrecognised gets the judge caps (the tighter ones)."""
    if not owner or owner in SYSTEM_OWNERS:
        return "operator"
    role = owner.split(":", 1)[0]
    return role if role in ROLES else "judge"


def _role_like(role: str) -> str:
    return f"{role}:%"


class LimitError(Exception):
    """Refused by a server-side limit. status: 403 (role), 429 (capacity), 503 (operator stop)."""

    def __init__(self, message: str, status: int = 429):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------------------- budgets & params
RUN_DEFAULTS = {"max_sequences": 120, "max_wall_seconds": 90}
MODEL_RUN_DEFAULTS = {"max_sequences": 12, "max_wall_seconds": 900, "max_model_calls": 80, "max_model_tokens": 120_000}
_BUDGET_INTS = ("max_sequences", "max_wall_seconds", "max_model_calls", "max_model_tokens")


def as_int(v, what: str) -> int:
    """An integer from a JSON value, or LimitError 400. Booleans, NaN and +/-Infinity are
    refused (int(inf) raises OverflowError, which would otherwise surface as a 500)."""
    if isinstance(v, bool):
        raise LimitError(f"{what} must be an integer", 400)
    try:
        return int(v)
    except (TypeError, ValueError, OverflowError):
        raise LimitError(f"{what} must be an integer", 400) from None


def _as_int(field: str, v) -> int:
    return as_int(v, f"budget.{field}")


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
    return as_int(v, f"params.{field}")


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
    except (TypeError, ValueError):
        raise LimitError("target_config temperature must be a number", 400) from None
    steps = as_int(given.get("max_steps", JUDGE_MAX_STEPS), "target_config.max_steps")
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


def spec_model(spec: dict) -> tuple[str, str] | None:
    """The provider/model a spec's target runs on (as providers.broker_for_spec picks it), or
    None for a target that needs no model."""
    cfg = spec["target"].get("config") or {}
    if spec["target"]["determinism"] != "stochastic" or not cfg.get("provider"):
        return None
    from .providers import PROVIDERS

    return cfg["provider"], cfg.get("model") or PROVIDERS.get(cfg["provider"], {}).get("default_model", "")


def judge_spec_check(spec: dict) -> None:
    """A judge may queue live-model work (runs, submissions, retries, regressions) only on a
    target that runs on the configured provider/model. An operator-published challenge may
    name another model; work on it is the operator's to start (403)."""
    m = spec_model(spec)
    if m is None:
        return
    provider, model = configured_model()
    if m != (provider, model):
        raise LimitError(f"this challenge's target runs on {m[0]}/{m[1]}; judge sessions can queue live-model work only "
                         f"on the configured model {provider}/{model}. Ask the operator to run it.", 403)


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


def tokens_today(conn: sqlite3.Connection, owner: str | None = None, role: str | None = None) -> int:
    """Model tokens used today (UTC): by one owner, by every session of a role, or by everyone."""
    ensure_tables(conn)
    sql = "SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) FROM model_usage WHERE day=?"
    args: tuple = (today(),)
    if owner is not None:
        sql, args = sql + " AND owner=?", args + (owner,)
    elif role is not None:
        sql, args = sql + " AND owner LIKE ?", args + (_role_like(role),)
    return int(conn.execute(sql, args).fetchone()[0])


# A job that was asked to cancel while running ("cancelling") still holds a worker until it
# reaches its next cancellation point, so it counts as active.
ACTIVE_SQL = "status IN ('queued','running','cancelling')"


def active_jobs(conn: sqlite3.Connection, owner: str | None = None, role: str | None = None) -> int:
    """Queued or running jobs: one owner's, every session of a role's, or all of them."""
    sql, args = f"SELECT COUNT(*) FROM jobs WHERE {ACTIVE_SQL}", ()
    if owner is not None:
        sql, args = sql + " AND owner=?", (owner,)
    elif role is not None:
        sql, args = sql + " AND owner LIKE ?", (_role_like(role),)
    return int(conn.execute(sql, args).fetchone()[0])


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
    """Why a model call or a model-using job is refused now (stop, global, role-wide or session
    budget), or None."""
    if stop_state(conn):
        return STOP_MESSAGE
    used = tokens_today(conn)
    ceiling = daily_token_ceiling()
    if used >= ceiling:
        return f"cost ceiling reached: {used} of {ceiling} model tokens used today (UTC); resets at 00:00 UTC"
    if owner:
        role = role_of(owner)
        c = caps(role)
        if c.daily_tokens:
            mine = tokens_today(conn, owner)
            if mine >= c.daily_tokens:
                return f"cost ceiling reached for this session: {mine} of {c.daily_tokens} model tokens used today (UTC)"
        if c.all_sessions_daily_tokens and owner not in SYSTEM_OWNERS:
            ours = tokens_today(conn, role=role)
            if ours >= c.all_sessions_daily_tokens:
                return (f"cost ceiling reached for {role} sessions: {ours} of {c.all_sessions_daily_tokens} model tokens "
                        f"used today (UTC) by all {role} sessions together; resets at 00:00 UTC")
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
def check_capacity(conn: sqlite3.Connection, owner: str, model_involved: bool = False) -> None:
    """Refuse a new job (raise LimitError) when the operator stop is in effect (503), the
    queue is full (429), this session or all sessions of its role together already have their
    active jobs (429), or a model-using job would start past a token ceiling (429). Call inside
    the transaction that enqueues."""
    if stop_state(conn):
        raise LimitError(STOP_MESSAGE, 503)
    total = active_jobs(conn)
    if total >= max_queued_jobs():
        raise LimitError(f"the evaluator queue is full ({total} jobs queued or running, limit {max_queued_jobs()}); "
                         "try again when some finish", 429)
    role = role_of(owner)
    c = caps(role)
    if owner not in SYSTEM_OWNERS:
        if c.max_active_jobs:
            mine = active_jobs(conn, owner=owner)
            if mine >= c.max_active_jobs:
                raise LimitError(f"this session already has {mine} active jobs (limit {c.max_active_jobs}); wait for one "
                                 "to finish or cancel it", 429)
        if c.all_sessions_active_jobs:
            ours = active_jobs(conn, role=role)
            if ours >= c.all_sessions_active_jobs:
                raise LimitError(f"{role} sessions together already have {ours} active jobs (limit "
                                 f"{c.all_sessions_active_jobs}); try again when some finish", 429)
    if model_involved:
        why = ceiling_refusal(conn, owner)
        if why:
            raise LimitError(why, 429)


def usage_view(conn: sqlite3.Connection, owner: str | None, role: str) -> dict:
    """Today's usage for a session. tokens_remaining is what this session can still use: the
    lower of its own budget and what is left of the budget all its role's sessions share."""
    c = caps(role)
    mine = tokens_today(conn, owner) if owner else 0
    active = active_jobs(conn, owner=owner) if owner else 0
    used = tokens_today(conn)
    out = {"active_jobs": active, "max_active_jobs": c.max_active_jobs or None,
           "tokens_today": mine, "daily_tokens": c.daily_tokens or None,
           "tokens_remaining": max(0, c.daily_tokens - mine) if c.daily_tokens else None,
           "global_tokens_today": used, "global_daily_ceiling": daily_token_ceiling(),
           "day": today()}
    if c.all_sessions_daily_tokens or c.all_sessions_active_jobs:
        ours = tokens_today(conn, role=role)
        out |= {"all_sessions_tokens_today": ours, "all_sessions_daily_tokens": c.all_sessions_daily_tokens or None,
                "all_sessions_active_jobs": active_jobs(conn, role=role),
                "all_sessions_max_active_jobs": c.all_sessions_active_jobs or None}
        if c.all_sessions_daily_tokens:
            left = max(0, c.all_sessions_daily_tokens - ours)
            out["tokens_remaining"] = left if out["tokens_remaining"] is None else min(out["tokens_remaining"], left)
    return out
