"""Room persistence through SQLAlchemy Core.

Everything here is portable SQL; the only dialect-specific code is the SQLite
setup in `create_db_engine`. To add another database, install its driver and
point DATABASE_URL at it (see README).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import (
    CheckConstraint,
    Column,
    Engine,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    create_engine,
    event,
    insert,
    make_url,
    select,
    update,
)
from sqlalchemy.pool import StaticPool

metadata = MetaData()

rooms = Table(
    "rooms",
    metadata,
    Column("id", String(64), primary_key=True),
    Column("title", String(255), nullable=False),
    Column("status", String(16), nullable=False),
    Column("canvas_json", Text, nullable=False),
    Column("revision", Integer, nullable=False),
    # ISO-8601 UTC strings, exactly as the API returns them.
    Column("created_at", String(40), nullable=False),
    Column("updated_at", String(40), nullable=False),
    Column("completed_at", String(40), nullable=True),
    CheckConstraint("status IN ('active', 'completed')", name="rooms_status_check"),
)


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


def create_db_engine(database_url: str) -> Engine:
    url = make_url(database_url)
    if url.get_backend_name() != "sqlite":
        # pre_ping replaces connections a database server closed while idle.
        return create_engine(url, pool_pre_ping=True)

    database = url.database or ""
    if database in ("", ":memory:"):
        # One shared connection; otherwise every thread would see its own empty database.
        engine = create_engine(url, poolclass=StaticPool, connect_args={"check_same_thread": False})
    else:
        Path(database).expanduser().parent.mkdir(parents=True, exist_ok=True)
        engine = create_engine(url)

    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _record):  # type: ignore[no-untyped-def]
        cursor = dbapi_conn.cursor()
        # WAL lets the REST reads proceed while a snapshot is being written.
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.close()

    return engine


class Database:
    """Blocking database access; callers run these methods via asyncio.to_thread."""

    def __init__(self, database_url: str):
        self.engine = create_db_engine(database_url)

    def init_schema(self) -> None:
        # Creates missing tables only; existing data is left untouched.
        metadata.create_all(self.engine)

    def close(self) -> None:
        self.engine.dispose()

    def create_room(self, room_id: str, title: str, canvas_json: str, now: str) -> None:
        with self.engine.begin() as conn:
            conn.execute(
                insert(rooms).values(
                    id=room_id,
                    title=title,
                    status="active",
                    canvas_json=canvas_json,
                    revision=0,
                    created_at=now,
                    updated_at=now,
                    completed_at=None,
                )
            )

    def get_room(self, room_id: str) -> RoomRecord | None:
        with self.engine.connect() as conn:
            row = conn.execute(select(rooms).where(rooms.c.id == room_id)).mappings().first()
        return RoomRecord(**row) if row is not None else None

    def save_snapshot(self, room_id: str, canvas_json: str, revision: int, now: str) -> bool:
        """Returns False when nothing was written (a newer snapshot or completion already exists)."""
        with self.engine.begin() as conn:
            result = conn.execute(
                update(rooms)
                .where(rooms.c.id == room_id, rooms.c.status == "active", rooms.c.revision <= revision)
                .values(canvas_json=canvas_json, revision=revision, updated_at=now)
            )
            return result.rowcount == 1

    def complete_room(self, room_id: str, canvas_json: str, revision: int, now: str) -> None:
        """Writes the final snapshot and flips status in one statement, so a crash cannot leave
        a completed room with a stale canvas."""
        with self.engine.begin() as conn:
            result = conn.execute(
                update(rooms)
                .where(rooms.c.id == room_id, rooms.c.status == "active", rooms.c.revision <= revision)
                .values(
                    status="completed",
                    canvas_json=canvas_json,
                    revision=revision,
                    updated_at=now,
                    completed_at=now,
                )
            )
            if result.rowcount != 1:
                raise RuntimeError(f"room {room_id} could not be completed")
