"""Migrations run safely when the API and several workers start at the same time."""

import threading

from counterproof.db import MIGRATIONS, connect, migrate


def test_concurrent_starts_apply_each_migration_once(tmp_path):
    path = tmp_path / "race.db"
    names = sorted(f.name for f in MIGRATIONS.glob("*.sql"))
    # an existing database from before the later migrations (only the first one applied)
    first = connect(path)
    first.execute("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)")
    from counterproof.db import _statements

    first.execute("BEGIN IMMEDIATE")
    for stmt in _statements((MIGRATIONS / names[0]).read_text(encoding="utf-8")):
        first.execute(stmt)
    first.execute("INSERT INTO schema_migrations(name, applied_at) VALUES (?, 0)", (names[0],))
    first.execute("COMMIT")
    first.close()

    n = 6
    barrier = threading.Barrier(n)
    errors: list[BaseException] = []

    def start():
        conn = connect(path)
        try:
            # every process reads the applied list before any of them takes the write lock
            conn.execute("SELECT name FROM schema_migrations").fetchall()
            barrier.wait()
            migrate(conn)
        except BaseException as e:  # noqa: BLE001 - the test reports any failure
            errors.append(e)
        finally:
            conn.close()

    threads = [threading.Thread(target=start) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    conn = connect(path)
    applied = [r["name"] for r in conn.execute("SELECT name FROM schema_migrations ORDER BY name")]
    assert applied == names
