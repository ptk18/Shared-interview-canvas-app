from __future__ import annotations

import json
import os
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable

import anyio
import pytest
from fastapi.testclient import TestClient

from sqlalchemy import select

from app.config import Settings
from app.db import create_db_engine, metadata, rooms
from app.main import create_app

# Run the suite against another database with e.g.
#   TEST_DATABASE_URL=postgresql+psycopg://localhost/sdi_test uv run pytest
# Tables are recreated before every test. Default: a fresh SQLite file per test.
TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "").strip()

RECV_TIMEOUT = 5.0
SYNC_TYPE = "__sync__"


class Closed(Exception):
    def __init__(self, code: int):
        super().__init__(f"closed with {code}")
        self.code = code


async def _receive(rx: Any, timeout: float) -> Any:
    with anyio.fail_after(timeout):
        return await rx.receive()


class WS:
    """Thin wrapper over Starlette's websocket test session adding receive timeouts.

    Uses the session's `portal` and `_send_rx` stream (verified in starlette/testclient.py)
    because the public `receive_*` methods block forever, which would hang a failing test.
    """

    def __init__(self, session: Any):
        self.session = session
        self.welcome: dict[str, Any] | None = None

    def send(self, obj: Any) -> None:
        self.session.send_text(json.dumps(obj))

    def send_text(self, text: str) -> None:
        self.session.send_text(text)

    def drop(self) -> None:
        """Simulate a network drop (1006). Leaving the `with` block afterwards is harmless;
        a plain exit instead sends 1000, which the server treats as leaving on purpose."""
        self.session.close(1006)

    def recv(self, timeout: float = RECV_TIMEOUT) -> dict[str, Any]:
        message = self.session.portal.call(_receive, self.session._send_rx, timeout)
        if message["type"] == "websocket.close":
            raise Closed(message.get("code", 1000))
        return json.loads(message["text"])

    def recv_type(self, type_: str, timeout: float = RECV_TIMEOUT) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while True:
            msg = self.recv(max(0.05, deadline - time.monotonic()))
            if msg["type"] == type_:
                return msg

    def recv_close(self, timeout: float = RECV_TIMEOUT) -> tuple[list[dict[str, Any]], int]:
        """Everything received until the server closes; returns (messages, close code)."""
        seen: list[dict[str, Any]] = []
        while True:
            try:
                seen.append(self.recv(timeout))
            except Closed as c:
                return seen, c.code

    def sync(self) -> list[dict[str, Any]]:
        """Barrier: returns every message queued for this connection before now.

        The queue is FIFO and the server answers the sync message in order, so negative
        assertions ("X was not delivered") need no sleeping.
        """
        self.send({"type": SYNC_TYPE})
        seen: list[dict[str, Any]] = []
        while True:
            msg = self.recv()
            if msg["type"] == "error" and msg["code"] == "invalid_message":
                return seen
            seen.append(msg)


def create_room(client: TestClient, title: str = "Design X") -> str:
    r = client.post("/api/rooms", json={"title": title})
    assert r.status_code == 201, r.text
    return r.json()["id"]


@contextmanager
def join(client: TestClient, room_id: str, name: str = "Ada", token: str | None = None):
    query = f"name={name}" + (f"&token={token}" if token else "")
    with client.websocket_connect(f"/ws/rooms/{room_id}?{query}") as session:
        ws = WS(session)
        ws.welcome = ws.recv()
        assert ws.welcome["type"] == "welcome", ws.welcome
        yield ws


def raw_connect(client: TestClient, path: str):
    return client.websocket_connect(path)


def rect(shape_id: str = "r1", **over: Any) -> dict[str, Any]:
    shape = {
        "id": shape_id, "type": "rect", "x": 0, "y": 0, "width": 100, "height": 60,
        "fill": "#ffffff", "stroke": "#1f2933", "label": "API", "textColor": "#1f2933",
    }
    shape.update(over)
    return shape


def op_msg(op: dict[str, Any], client_op_id: str = "c_1") -> dict[str, Any]:
    return {"type": "op", "clientOpId": client_op_id, "op": op}


def create_op(shape: dict[str, Any]) -> dict[str, Any]:
    return {"kind": "create", "shape": shape}


def wait_for(cond: Callable[[], bool], timeout: float = RECV_TIMEOUT, what: str = "condition") -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cond():
            return
        time.sleep(0.01)
    raise AssertionError(f"timed out waiting for {what}")


def db_row(settings: Settings, room_id: str) -> dict[str, Any] | None:
    """Reads a room straight from the database, bypassing the app."""
    engine = create_db_engine(settings.database_url)
    try:
        with engine.connect() as conn:
            row = conn.execute(select(rooms).where(rooms.c.id == room_id)).mappings().first()
            return dict(row) if row is not None else None
    finally:
        engine.dispose()


@pytest.fixture
def make_settings(tmp_path: Path) -> Callable[..., Settings]:
    if TEST_DATABASE_URL:
        engine = create_db_engine(TEST_DATABASE_URL)
        metadata.drop_all(engine)
        engine.dispose()
    database_url = TEST_DATABASE_URL or f"sqlite:///{tmp_path / 'data' / 'app.db'}"

    def factory(**over: Any) -> Settings:
        values: dict[str, Any] = dict(
            database_url=database_url, save_debounce_s=0.05, grace_period_s=0.4, save_retry_s=0.1
        )
        values.update(over)
        return Settings(**values)

    return factory


@pytest.fixture
def make_client(make_settings: Callable[..., Settings]):
    """Factory so a test can choose timing settings; every client is shut down at teardown."""
    opened: list[TestClient] = []

    def factory(**over: Any) -> TestClient:
        c = TestClient(create_app(make_settings(**over)))
        c.__enter__()
        opened.append(c)
        return c

    yield factory
    for c in reversed(opened):
        c.__exit__(None, None, None)


@pytest.fixture
def client(make_client) -> TestClient:
    return make_client()
