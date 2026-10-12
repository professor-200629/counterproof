"""SQLite persistence with numbered SQL migrations, plus a content-addressed artifact store.

The database is shared by the API process and the worker process (WAL mode). Large
artifacts - specs, candidates and evidence bundles - are written once to
``data/artifacts/<sha256>.json`` and verified against their digest on every read.
"""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from .canonical import canonical_json, digest
from .config import settings

MIGRATIONS = Path(__file__).with_name("migrations")


def now() -> int:
    return int(time.time())


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def connect(path: Path | None = None) -> sqlite3.Connection:
    p = path or settings().db_path
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(p, timeout=30, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def migrate(conn: sqlite3.Connection) -> list[str]:
    conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)")
    done = {r["name"] for r in conn.execute("SELECT name FROM schema_migrations")}
    applied = []
    for f in sorted(MIGRATIONS.glob("*.sql")):
        if f.name in done:
            continue
        conn.execute("BEGIN IMMEDIATE")
        try:
            for stmt in _statements(f.read_text(encoding="utf-8")):
                conn.execute(stmt)
            conn.execute("INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)", (f.name, now()))
            conn.execute("COMMIT")
            applied.append(f.name)
        except Exception:
            conn.execute("ROLLBACK")
            raise
    return applied


def _statements(sql: str) -> list[str]:
    lines = [ln for ln in sql.splitlines() if not ln.strip().startswith("--")]
    return [s.strip() for s in "\n".join(lines).split(";") if s.strip()]


@contextmanager
def tx(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise


def row(r: sqlite3.Row | None) -> dict | None:
    if r is None:
        return None
    d = dict(r)
    for k in ("json", "params", "result", "record", "budget", "provenance", "local_check", "summary",
              "typed_data", "detail", "verification"):
        if k in d and isinstance(d[k], str):
            try:
                d[k] = json.loads(d[k])
            except json.JSONDecodeError:
                pass
    return d


def rows(rs) -> list[dict]:
    return [row(r) for r in rs]


def dumps(v: Any) -> str:
    return json.dumps(v, separators=(",", ":"), default=str)


def log_activity(conn: sqlite3.Connection, kind: str, message: str, challenge_id: int | None = None, ref: str | None = None) -> None:
    conn.execute("INSERT INTO activity(challenge_id, kind, message, ref, created_at) VALUES (?,?,?,?,?)",
                 (challenge_id, kind, message[:500], ref, now()))


# ----------------------------------------------------------------------- artifacts
class ArtifactStore:
    def __init__(self, root: Path | None = None):
        self.root = root or settings().artifacts_dir
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, d: str) -> Path:
        hexpart = d.split(":", 1)[1]
        if len(hexpart) != 64 or not all(c in "0123456789abcdef" for c in hexpart):
            raise ValueError("bad digest")
        return self.root / f"{hexpart}.json"

    def put(self, value: Any) -> str:
        """Write once. Several processes (API, workers, signer) may store the same digest at
        the same time: each writes its own uniquely named temporary file, and a writer that
        loses the race (Windows refuses to replace a file another process has open) accepts
        the file already there when it holds exactly the same bytes."""
        d = digest(value)
        p = self._path(d)
        if p.exists():
            return d
        data = canonical_json(value)
        tmp = p.with_name(f"{p.stem}.{uuid.uuid4().hex}.tmp")
        try:
            tmp.write_bytes(data)
            for attempt in range(6):
                try:
                    tmp.replace(p)
                    break
                except PermissionError:
                    if self._holds(p, data):
                        break
                    if attempt == 5:
                        raise
                    time.sleep(0.02 * (attempt + 1))
        finally:
            tmp.unlink(missing_ok=True)
        return d

    @staticmethod
    def _holds(p: Path, data: bytes) -> bool:
        try:
            return p.read_bytes() == data
        except OSError:
            return False

    def get(self, d: str) -> Any:
        p = self._path(d)
        data = p.read_bytes()
        value = json.loads(data)
        if digest(value) != d:
            raise ValueError(f"artifact {d} failed its integrity check")
        return value

    def exists(self, d: str) -> bool:
        try:
            return self._path(d).exists()
        except ValueError:
            return False
