-- CounterProof schema v1
CREATE TABLE specs (
    digest TEXT PRIMARY KEY,
    format TEXT NOT NULL,
    title TEXT NOT NULL,
    target_key TEXT NOT NULL,
    supersedes TEXT,
    json TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE challenges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spec_digest TEXT NOT NULL REFERENCES specs(digest),
    status TEXT NOT NULL,                 -- draft | awaiting_funding | funded | settled | refunded | offchain
    network TEXT NOT NULL,                -- anvil-local | monad-testnet | offchain
    chain_id INTEGER,
    contract TEXT,
    onchain_id TEXT,
    fund_tx TEXT,
    reward_wei TEXT,
    note TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX challenges_onchain ON challenges(chain_id, contract, onchain_id) WHERE onchain_id IS NOT NULL;

CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,                   -- search | evaluation | regression
    status TEXT NOT NULL,                 -- queued | running | done | failed | cancelled
    params TEXT NOT NULL,
    result TEXT,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 2,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    worker TEXT,
    heartbeat_at INTEGER,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER
);
CREATE INDEX jobs_status ON jobs(status, created_at);

CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    challenge_id INTEGER NOT NULL REFERENCES challenges(id),
    job_id TEXT REFERENCES jobs(id),
    strategy TEXT NOT NULL,
    strategy_version TEXT NOT NULL,
    mode TEXT NOT NULL,                   -- deterministic | model-assisted
    params TEXT NOT NULL,
    budget TEXT NOT NULL,
    status TEXT NOT NULL,                 -- queued | running | candidate_found | no_violation_found | failed | cancelled
    record TEXT,
    provenance TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE candidates (
    id TEXT PRIMARY KEY,
    challenge_id INTEGER NOT NULL REFERENCES challenges(id),
    run_id TEXT REFERENCES runs(id),
    digest TEXT NOT NULL,
    claimed_rule TEXT NOT NULL,
    json TEXT NOT NULL,
    local_check TEXT,
    status TEXT NOT NULL,                 -- candidate_found | submitted | replaying | verified_violation | not_reproduced | inconclusive | failed | cancelled
    created_at INTEGER NOT NULL,
    UNIQUE(challenge_id, digest)
);

CREATE TABLE submissions (
    id TEXT PRIMARY KEY,                  -- on-chain submissionId (bytes32 hex) or local id for off-chain challenges
    challenge_id INTEGER NOT NULL REFERENCES challenges(id),
    candidate_id TEXT REFERENCES candidates(id),
    candidate_digest TEXT NOT NULL,
    challenger TEXT NOT NULL,
    recipient TEXT NOT NULL,
    commit_tx TEXT,
    committed_at INTEGER,
    source TEXT NOT NULL,                 -- chain | offchain
    created_at INTEGER NOT NULL
);

CREATE TABLE evaluations (
    id TEXT PRIMARY KEY,
    challenge_id INTEGER NOT NULL REFERENCES challenges(id),
    submission_id TEXT NOT NULL REFERENCES submissions(id),
    job_id TEXT REFERENCES jobs(id),
    status TEXT NOT NULL,                 -- queued | replaying | <evidence outcome>
    outcome TEXT,
    evidence_digest TEXT,
    summary TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER,
    UNIQUE(submission_id)
);

CREATE TABLE attestations (
    id TEXT PRIMARY KEY,
    challenge_id INTEGER NOT NULL UNIQUE REFERENCES challenges(id),   -- one reward per challenge
    evaluation_id TEXT NOT NULL UNIQUE REFERENCES evaluations(id),
    submission_id TEXT NOT NULL,
    typed_data TEXT NOT NULL,
    signature TEXT NOT NULL,
    signer TEXT NOT NULL,
    expiry INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE transactions (
    hash TEXT NOT NULL,
    chain_id INTEGER NOT NULL,
    kind TEXT NOT NULL,                   -- fund | commit | settle | withdraw | refund | deploy
    status TEXT NOT NULL,                 -- pending | confirmed | failed
    challenge_id INTEGER,
    from_addr TEXT,
    detail TEXT,
    block_number INTEGER,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (chain_id, hash)
);

CREATE TABLE regressions (
    id TEXT PRIMARY KEY,
    source_candidate_id TEXT NOT NULL REFERENCES candidates(id),
    source_challenge_id INTEGER NOT NULL REFERENCES challenges(id),
    target_key TEXT NOT NULL,
    spec_digest TEXT NOT NULL,
    job_id TEXT REFERENCES jobs(id),
    status TEXT NOT NULL,
    outcome TEXT,
    evidence_digest TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
);

CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    challenge_id INTEGER,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    ref TEXT,
    created_at INTEGER NOT NULL
);
