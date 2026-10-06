"""Durable job queue on SQLite: claim, heartbeat, cancel, recover.

Jobs survive restarts. A job left in `running` by a worker that stopped (its heartbeat is
stale) is requeued if it has attempts left, or marked failed with the reason
"interrupted", so the interface never shows a run as live when nothing is running it.
"""

from __future__ import annotations

import sqlite3

from .db import dumps, new_id, now, row, tx

STALE_SECONDS = 30


def enqueue(conn: sqlite3.Connection, kind: str, params: dict, max_attempts: int = 2) -> str:
    jid = new_id("job")
    conn.execute("INSERT INTO jobs(id, kind, status, params, max_attempts, created_at) VALUES (?,?,?,?,?,?)",
                 (jid, kind, "queued", dumps(params), max_attempts, now()))
    return jid


def claim(conn: sqlite3.Connection, worker: str) -> dict | None:
    t = now()
    with tx(conn):
        r = conn.execute(
            "UPDATE jobs SET status='running', worker=?, attempts=attempts+1, started_at=?, heartbeat_at=? "
            "WHERE id = (SELECT id FROM jobs WHERE status='queued' ORDER BY created_at, rowid LIMIT 1) RETURNING *",
            (worker, t, t)).fetchone()
    return row(r)


def heartbeat(conn: sqlite3.Connection, job_id: str) -> bool:
    """Refresh the heartbeat; returns True if cancellation was requested."""
    conn.execute("UPDATE jobs SET heartbeat_at=? WHERE id=?", (now(), job_id))
    r = conn.execute("SELECT cancel_requested FROM jobs WHERE id=?", (job_id,)).fetchone()
    return bool(r and r["cancel_requested"])


def finish(conn: sqlite3.Connection, job_id: str, status: str, result: dict | None = None, error: str | None = None) -> None:
    conn.execute("UPDATE jobs SET status=?, result=?, error=?, finished_at=? WHERE id=?",
                 (status, dumps(result) if result is not None else None, error, now(), job_id))


def request_cancel(conn: sqlite3.Connection, job_id: str) -> str:
    """Queued jobs are cancelled immediately; running jobs are flagged for the worker."""
    with tx(conn):
        r = conn.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
        if r is None:
            return "unknown"
        if r["status"] == "queued":
            conn.execute("UPDATE jobs SET status='cancelled', cancel_requested=1, finished_at=? WHERE id=?", (now(), job_id))
            return "cancelled"
        if r["status"] == "running":
            conn.execute("UPDATE jobs SET cancel_requested=1 WHERE id=?", (job_id,))
            return "cancelling"
        return r["status"]


def recover(conn: sqlite3.Connection, stale_seconds: int = STALE_SECONDS) -> list[dict]:
    """Requeue or fail jobs whose worker stopped. Returns what changed."""
    cutoff = now() - stale_seconds
    changed = []
    with tx(conn):
        stale = conn.execute("SELECT * FROM jobs WHERE status='running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)",
                             (cutoff,)).fetchall()
        for j in stale:
            if j["cancel_requested"]:
                conn.execute("UPDATE jobs SET status='cancelled', finished_at=?, error=? WHERE id=?",
                             (now(), "cancelled; worker stopped before acknowledging", j["id"]))
                changed.append({"id": j["id"], "kind": j["kind"], "to": "cancelled"})
            elif j["attempts"] < j["max_attempts"]:
                conn.execute("UPDATE jobs SET status='queued', worker=NULL, error=? WHERE id=?",
                             (f"requeued after interruption (attempt {j['attempts']} of {j['max_attempts']})", j["id"]))
                changed.append({"id": j["id"], "kind": j["kind"], "to": "queued"})
            else:
                conn.execute("UPDATE jobs SET status='failed', finished_at=?, error=? WHERE id=?",
                             (now(), f"interrupted: the worker stopped while running (after {j['attempts']} attempts)", j["id"]))
                changed.append({"id": j["id"], "kind": j["kind"], "to": "failed"})
    return changed


def get(conn: sqlite3.Connection, job_id: str) -> dict | None:
    return row(conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone())
