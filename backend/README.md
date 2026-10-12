# Whiteboard backend

FastAPI + SQLite server for the real-time system-design interview whiteboard.
The wire contract is `../_docs/protocol.md`; this implements it exactly.

## Setup

```sh
uv sync
```

## Run

```sh
uv run uvicorn app.main:app --reload --port 8000
```

The server is a single process: room state lives in memory and is snapshotted
to SQLite (`data/app.db`, created on first start, git-ignored). Do not run it
with multiple workers.

## Test

```sh
uv run pytest
```

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `SDI_DB_PATH` | `backend/data/app.db` | SQLite file |
| `SDI_SAVE_DEBOUNCE_MS` | `500` | quiet time after the last op before a snapshot is written |
| `SDI_GRACE_PERIOD_S` | `30` | how long a disconnected participant keeps its slot |

## Layout

- `app/canvas.py` — pure shape/op validation and apply (tested against `../shared/op-validation-cases.json`)
- `app/rooms.py` — in-memory rooms, slots, per-connection outbound queues, debounced saves
- `app/db.py` — SQLite schema and snapshot writes (never overwrite a higher revision)
- `app/main.py` — `create_app()` factory, REST routes, WebSocket endpoint
