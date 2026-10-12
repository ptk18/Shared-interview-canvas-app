from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import DEFAULT_DATABASE_URL, Settings
from app.db import Database, parse_database_url
from app.main import create_app

NOW = "2026-01-01T00:00:00.000Z"


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        ({"DATABASE_URL": "sqlite:////tmp/x.db"}, "sqlite:////tmp/x.db"),
        ({"DATABASE_URL": "postgresql+psycopg://u:p@db:5432/sdi"}, "postgresql+psycopg://u:p@db:5432/sdi"),
        ({"DATABASE_URL": "   "}, DEFAULT_DATABASE_URL),
        ({}, DEFAULT_DATABASE_URL),
    ],
)
def test_database_url_comes_from_the_environment(monkeypatch, env, expected):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    assert Settings.from_env().database_url == expected


@pytest.mark.parametrize(
    ("given", "driver"),
    [
        ("postgres://u:p@db:5432/sdi", "postgresql+psycopg"),
        ("postgresql://u:p@db:5432/sdi", "postgresql"),
        ("postgresql+psycopg://u:p@db:5432/sdi", "postgresql+psycopg"),
        ("sqlite:///data/app.db", "sqlite"),
    ],
)
def test_postgres_scheme_from_hosting_providers_is_accepted(given, driver):
    url = parse_database_url(given)
    assert url.drivername == driver
    assert (url.username, url.password, url.host, url.port) == (("u", "p", "db", 5432) if url.host else (None,) * 4)


def test_default_database_is_a_sqlite_file_in_backend_data():
    assert DEFAULT_DATABASE_URL.startswith("sqlite:///")
    assert DEFAULT_DATABASE_URL.endswith(str(Path("backend") / "data" / "app.db"))


def test_creates_the_directory_for_a_sqlite_file(tmp_path):
    path = tmp_path / "nested" / "dir" / "rooms.db"
    db = Database(f"sqlite:///{path}")
    db.init_schema()
    db.create_room("r1", "T", '{"revision":0,"shapes":[]}', NOW)
    db.close()
    assert path.exists()


def test_in_memory_sqlite_is_shared_across_threads():
    # The app calls the database from worker threads (asyncio.to_thread).
    db = Database("sqlite://")
    db.init_schema()
    t = threading.Thread(target=db.create_room, args=("r1", "T", "{}", NOW))
    t.start()
    t.join()
    found: list = []
    t = threading.Thread(target=lambda: found.append(db.get_room("r1")))
    t.start()
    t.join()
    assert found[0] is not None and found[0].title == "T"
    db.close()


def test_whole_app_runs_on_in_memory_sqlite():
    with TestClient(create_app(Settings(database_url="sqlite://"))) as client:
        room = client.post("/api/rooms", json={"title": "Memory"}).json()
        assert client.get(f"/api/rooms/{room['id']}").json()["title"] == "Memory"


def test_opens_a_database_created_before_sqlalchemy(tmp_path):
    # Schema exactly as the earlier sqlite3-based version created it.
    path = tmp_path / "app.db"
    conn = sqlite3.connect(path)
    conn.execute(
        """CREATE TABLE rooms (
            id TEXT PRIMARY KEY, title TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('active', 'completed')),
            canvas_json TEXT NOT NULL, revision INTEGER NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT)"""
    )
    conn.execute("INSERT INTO rooms VALUES ('old', 'Legacy', 'active', '{}', 4, ?, ?, NULL)", (NOW, NOW))
    conn.commit()
    conn.close()

    db = Database(f"sqlite:///{path}")
    db.init_schema()
    rec = db.get_room("old")
    assert rec is not None and rec.title == "Legacy" and rec.revision == 4
    assert db.save_snapshot("old", '{"x":1}', 5, NOW) is True
    db.complete_room("old", '{"x":2}', 6, NOW)
    assert db.get_room("old").status == "completed"
    db.close()


def test_completed_room_is_never_written_again(tmp_path):
    db = Database(f"sqlite:///{tmp_path / 'app.db'}")
    db.init_schema()
    db.create_room("r1", "T", "{}", NOW)
    db.complete_room("r1", '{"final":true}', 3, NOW)
    assert db.save_snapshot("r1", '{"late":true}', 9, NOW) is False
    with pytest.raises(RuntimeError):
        db.complete_room("r1", "{}", 10, NOW)
    assert db.get_room("r1").canvas_json == '{"final":true}'
    db.close()
