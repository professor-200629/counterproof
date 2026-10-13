-- Authenticated judge/demo sessions, ownership of queued work, the model-token ledger and the
-- operator stop flag (see backend/counterproof/auth.py and limits.py).
--
-- sessions: the cookie holds a random session id; only its SHA-256 is stored here. owner is
-- the public handle recorded on the work a session queues ("judge:sess_..."), never the id.
CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    role TEXT NOT NULL,                   -- judge | operator
    owner TEXT NOT NULL UNIQUE,
    csrf_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sessions_expiry ON sessions(expires_at);

-- Who queued the work: "operator" (operator bearer token), "<role>:<session handle>" for a
-- cookie session, NULL for rows created before authentication existed (operator-only to touch).
ALTER TABLE jobs ADD COLUMN owner TEXT;
ALTER TABLE runs ADD COLUMN owner TEXT;
ALTER TABLE evaluations ADD COLUMN owner TEXT;
ALTER TABLE regressions ADD COLUMN owner TEXT;
CREATE INDEX jobs_owner_status ON jobs(owner, status);

-- One row per successful model call (generator or target broker). The same DDL is run with
-- IF NOT EXISTS by limits.py, so a model client never fails on an unmigrated database.
CREATE TABLE IF NOT EXISTS model_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day TEXT NOT NULL,                    -- UTC date, YYYY-MM-DD
    owner TEXT,
    job_id TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS model_usage_day_owner ON model_usage(day, owner);

-- Persisted operator switches (key "stop": the operator stop, as JSON).
CREATE TABLE IF NOT EXISTS operator_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
