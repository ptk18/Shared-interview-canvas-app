# Whiteboard backend

FastAPI server for the real-time system-design interview whiteboard, persisting
to any SQLAlchemy-supported database (SQLite by default).
The wire contract is `../_docs/protocol.md`; this implements it exactly.

## Setup

```sh
uv sync
```

## Run

```sh
uv run uvicorn app.main:app --reload --port 8000
```

The server is a single process: live room state is held in memory (the
authoritative copy during a session) and snapshotted to the database 500 ms after
the last change. By default that's SQLite at `data/app.db`, created on first
start and git-ignored. Do not run it with multiple workers.

## Test

```sh
uv run pytest
```

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `sqlite:///<backend>/data/app.db` | SQLAlchemy database URL |
| `SDI_SAVE_DEBOUNCE_MS` | `500` | quiet time after the last op before a snapshot is written |
| `SDI_GRACE_PERIOD_S` | `30` | how long a disconnected participant keeps its slot |

## Databases

Persistence goes through SQLAlchemy Core (`app/db.py`) using portable SQL, so
the database is chosen by `DATABASE_URL` alone:

```sh
DATABASE_URL=sqlite:///data/app.db uv run uvicorn app.main:app   # relative to the cwd
DATABASE_URL=sqlite:////abs/path/app.db uv run uvicorn app.main:app
DATABASE_URL=sqlite:// uv run uvicorn app.main:app               # in-memory, lost on exit
```

The only database-specific code is the SQLite setup in `create_db_engine`
(WAL mode, busy timeout, creating the file's folder, a shared connection for
in-memory databases). To add Postgres later:

1. Add a driver: `uv add "psycopg[binary]"`.
2. Run with `DATABASE_URL=postgresql+psycopg://user:password@host:5432/dbname`.
3. Run the test suite against it:
   `TEST_DATABASE_URL=postgresql+psycopg://…/sdi_test uv run pytest` (it drops and
   recreates the tables before each test, so use a throwaway database).

Tables are created at startup if missing (`metadata.create_all`); existing
tables and data are left as they are. Once the schema needs to change, add a
migration tool such as Alembic.

## Layout

- `app/canvas.py` — pure shape/op validation and apply (tested against `../shared/op-validation-cases.json`)
- `app/rooms.py` — in-memory rooms, slots, per-connection outbound queues, debounced saves
- `app/db.py` — SQLAlchemy schema and snapshot writes (never overwrite a higher revision or a completed room)
- `app/main.py` — `create_app()` factory, REST routes, WebSocket endpoint
