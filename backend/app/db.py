from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS rooms (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('active', 'completed')),
    canvas_json  TEXT NOT NULL,
    revision     INTEGER NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    completed_at TEXT
)
"""


@dataclass(frozen=True)
class RoomRecord:
    id: str
    title: str
    status: str
    canvas_json: str
    revision: int
    created_at: str
    updated_at: str
    completed_at: str | None


class Database:
    """Blocking SQLite access; callers run these methods via asyncio.to_thread.

    A connection per call keeps the class thread-safe without a pool; at this
    scale the open cost is negligible next to the fsync of a snapshot write.
    """

    def __init__(self, path: Path):
        self.path = Path(path)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=5.0)
        conn.row_factory = sqlite3.Row
        return conn

    def init_schema(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = self._connect()
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            with conn:
                conn.execute(SCHEMA)
        finally:
            conn.close()

    def create_room(self, room_id: str, title: str, canvas_json: str, now: str) -> None:
        conn = self._connect()
        try:
            with conn:
                conn.execute(
                    "INSERT INTO rooms (id, title, status, canvas_json, revision, created_at, updated_at)"
                    " VALUES (?, ?, 'active', ?, 0, ?, ?)",
                    (room_id, title, canvas_json, now, now),
                )
        finally:
            conn.close()

    def get_room(self, room_id: str) -> RoomRecord | None:
        conn = self._connect()
        try:
            row = conn.execute("SELECT * FROM rooms WHERE id = ?", (room_id,)).fetchone()
        finally:
            conn.close()
        if row is None:
            return None
        return RoomRecord(**{k: row[k] for k in row.keys()})

    def save_snapshot(self, room_id: str, canvas_json: str, revision: int, now: str) -> bool:
        """Returns False when nothing was written (a newer snapshot or completion already exists)."""
        conn = self._connect()
        try:
            with conn:
                cur = conn.execute(
                    "UPDATE rooms SET canvas_json = ?, revision = ?, updated_at = ?"
                    " WHERE id = ? AND status = 'active' AND revision <= ?",
                    (canvas_json, revision, now, room_id, revision),
                )
                return cur.rowcount == 1
        finally:
            conn.close()

    def complete_room(self, room_id: str, canvas_json: str, revision: int, now: str) -> None:
        """Writes the final snapshot and flips status in one statement, so a crash cannot leave
        a completed room with a stale canvas."""
        conn = self._connect()
        try:
            with conn:
                cur = conn.execute(
                    "UPDATE rooms SET status = 'completed', canvas_json = ?, revision = ?,"
                    " updated_at = ?, completed_at = ?"
                    " WHERE id = ? AND status = 'active' AND revision <= ?",
                    (canvas_json, revision, now, now, room_id, revision),
                )
                if cur.rowcount != 1:
                    raise RuntimeError(f"room {room_id} could not be completed")
        finally:
            conn.close()
