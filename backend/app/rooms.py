"""In-memory room state, WebSocket sessions, debounced persistence.

Concurrency model: everything that mutates room state (apply op, assign revision,
enqueue to connections, join/leave) is synchronous code on the event loop with no
`await` in between, so server order is exactly the order messages are processed.
Awaits happen only for SQLite I/O (in a worker thread) and are always re-validated
against current state afterwards.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import secrets
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from fastapi import WebSocket

from .canvas import AppliedOp, Shape, apply_op, is_number, parse_json
from .config import Settings
from .db import Database, RoomRecord

log = logging.getLogger("sdi.rooms")

MAX_SLOTS = 2
COLORS = ("#e8590c", "#1c7ed6")
MAX_NAME_LEN = 40

CLOSE_INVALID_NAME = 4000
CLOSE_REPLACED = 4001
CLOSE_ROOM_FULL = 4003
CLOSE_ROOM_NOT_FOUND = 4004
CLOSE_ROOM_COMPLETED = 4009


NORMAL_CLOSURE = 1000


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def dumps(obj: Any) -> str:
    # ASCII-only output: lone surrogates in user strings must not break UTF-8 encoding later.
    return json.dumps(obj, separators=(",", ":"), allow_nan=False)


def canvas_json(revision: int, shapes: dict[str, Shape]) -> str:
    return dumps({"revision": revision, "shapes": list(shapes.values())})


class _Close:
    __slots__ = ("code",)

    def __init__(self, code: int):
        self.code = code


class Connection:
    """One WebSocket plus its outbound queue. A single writer task drains the queue, which
    is what guarantees per-connection message ordering."""

    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.queue: asyncio.Queue[str | _Close] = asyncio.Queue()
        self.closing = False
        self.participant: Participant | None = None
        self.room: Room | None = None
        # Close code the client sent; None when the socket dropped without a close frame.
        self.client_close_code: int | None = None
        self.writer: asyncio.Task[None] = asyncio.get_running_loop().create_task(self._write_loop())

    def send(self, message: dict[str, Any]) -> None:
        self.send_text(dumps(message))

    def send_text(self, text: str) -> None:
        if not self.closing:
            self.queue.put_nowait(text)

    def close(self, code: int) -> None:
        """Queued after pending messages; later sends are dropped."""
        if not self.closing:
            self.closing = True
            self.queue.put_nowait(_Close(code))

    async def _write_loop(self) -> None:
        try:
            while True:
                item = await self.queue.get()
                if isinstance(item, _Close):
                    await self.ws.close(code=item.code)
                    return
                await self.ws.send_text(item)
        except Exception:
            # Peer went away mid-write; the read side notices the disconnect and cleans up.
            self.closing = True


@dataclass
class Participant:
    id: str
    token: str
    name: str
    color: str
    conn: Connection | None = None
    grace_handle: asyncio.TimerHandle | None = None

    def public(self) -> dict[str, str]:
        return {"id": self.id, "name": self.name, "color": self.color}


@dataclass
class Room:
    id: str
    title: str
    created_at: str
    updated_at: str
    shapes: dict[str, Shape]
    revision: int
    saved_revision: int
    participants: dict[str, Participant] = field(default_factory=dict)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    save_handle: asyncio.TimerHandle | None = None
    ending: bool = False
    closed: bool = False

    def room_json(self, status: str = "active", completed_at: str | None = None) -> dict[str, Any]:
        return room_json(self.id, self.title, status, self.created_at, self.updated_at, completed_at)

    def canvas(self) -> dict[str, Any]:
        return {"revision": self.revision, "shapes": list(self.shapes.values())}


def room_json(
    room_id: str, title: str, status: str, created_at: str, updated_at: str, completed_at: str | None
) -> dict[str, Any]:
    return {
        "id": room_id,
        "title": title,
        "status": status,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "completedAt": completed_at,
    }


def record_json(rec: RoomRecord) -> dict[str, Any]:
    return room_json(rec.id, rec.title, rec.status, rec.created_at, rec.updated_at, rec.completed_at)


class RoomManager:
    def __init__(self, db: Database, settings: Settings):
        self.db = db
        self.settings = settings
        self.rooms: dict[str, Room] = {}
        self._completed_ids: set[str] = set()
        self._tasks: set[asyncio.Task[Any]] = set()
        self._stopping = False

    # ------------------------------------------------------------------ REST support

    async def create_room(self, title: str) -> dict[str, Any]:
        room_id = secrets.token_urlsafe(16)
        now = utc_now()
        await asyncio.to_thread(self.db.create_room, room_id, title, canvas_json(0, {}), now)
        return room_json(room_id, title, "active", now, now, None)

    async def get_room_view(self, room_id: str) -> dict[str, Any] | None:
        live = self.rooms.get(room_id)
        if live is not None:
            return {**live.room_json(), "canvas": live.canvas()}
        rec = await asyncio.to_thread(self.db.get_room, room_id)
        if rec is None:
            return None
        # A join may have loaded the room while we waited on SQLite; its memory is authoritative.
        live = self.rooms.get(room_id)
        if live is not None:
            return {**live.room_json(), "canvas": live.canvas()}
        return {**record_json(rec), "canvas": {"revision": rec.revision, "shapes": json.loads(rec.canvas_json)["shapes"]}}

    # ------------------------------------------------------------------ WebSocket session

    async def serve(self, ws: WebSocket, room_id: str, name: str | None, token: str | None) -> None:
        await ws.accept()
        conn = Connection(ws)
        reader: asyncio.Task[None] | None = None
        try:
            room = await self._join(conn, room_id, name, token)
            if room is not None:
                reader = asyncio.get_running_loop().create_task(self._read_loop(conn, room))
                await asyncio.wait({reader, conn.writer}, return_when=asyncio.FIRST_COMPLETED)
            else:
                await conn.writer  # flush error + close frame
        finally:
            self._disconnect(conn)
            for task in (reader, conn.writer):
                if task is None:
                    continue
                if not task.done():
                    task.cancel()  # not awaited: both loops exit on cancellation without cleanup of their own
                elif not task.cancelled() and task.exception() is not None:
                    log.error("connection task failed", exc_info=task.exception())

    async def _read_loop(self, conn: Connection, room: Room) -> None:
        while True:
            message = await conn.ws.receive()
            if message["type"] == "websocket.disconnect":
                conn.client_close_code = message.get("code")
                return
            text = message.get("text")
            if text is None:
                self._invalid_message(conn, "binary frames are not supported")
                continue
            try:
                self._handle_text(conn, room, text)
            except Exception:
                log.exception("unhandled error processing message in room %s", room.id)
                conn.send({"type": "error", "code": "internal_error", "message": "internal error"})

    @staticmethod
    def _reject_join(conn: Connection, code: int, error_code: str, message: str) -> None:
        conn.send({"type": "error", "code": error_code, "message": message})
        conn.close(code)

    async def _join(self, conn: Connection, room_id: str, name: str | None, token: str | None) -> Room | None:
        clean_name = name.strip() if isinstance(name, str) else ""
        if not clean_name or len(clean_name) > MAX_NAME_LEN:
            self._reject_join(conn, CLOSE_INVALID_NAME, "invalid_name", "name must be 1-40 characters")
            return None

        room = self.rooms.get(room_id)
        if room is None:
            if room_id in self._completed_ids:
                self._reject_join(conn, CLOSE_ROOM_COMPLETED, "room_completed", "this session has ended")
                return None
            rec = await asyncio.to_thread(self.db.get_room, room_id)
            if rec is None:
                self._reject_join(conn, CLOSE_ROOM_NOT_FOUND, "room_not_found", "room not found")
                return None
            if rec.status == "completed" or room_id in self._completed_ids:
                self._reject_join(conn, CLOSE_ROOM_COMPLETED, "room_completed", "this session has ended")
                return None
            # Another join may have adopted the room while we were reading SQLite.
            room = self.rooms.get(room_id) or self._adopt(rec)

        if room.ending or room.closed:
            self._reject_join(conn, CLOSE_ROOM_COMPLETED, "room_completed", "this session has ended")
            return None

        # ---- synchronous from here: slot assignment + welcome must be atomic w.r.t. ops
        participant = self._match_token(room, token)
        if participant is not None:
            self._cancel_grace(participant)
            previous = participant.conn
            if previous is not None:
                previous.participant = None
                previous.send({"type": "error", "code": "replaced", "message": "connection replaced by a newer one"})
                previous.close(CLOSE_REPLACED)
            participant.name = clean_name
            participant.conn = conn
            conn.participant = participant
            if previous is None:
                self._broadcast(room, {"type": "participant_joined", "participant": participant.public()}, exclude=participant)
        else:
            if len(room.participants) >= MAX_SLOTS:
                self._reject_join(conn, CLOSE_ROOM_FULL, "room_full", "room already has two participants")
                return None
            used = {p.color for p in room.participants.values()}
            color = next((c for c in COLORS if c not in used), COLORS[0])
            participant = Participant(
                id="p_" + secrets.token_urlsafe(9),
                token=secrets.token_urlsafe(24),
                name=clean_name,
                color=color,
                conn=conn,
            )
            room.participants[participant.id] = participant
            conn.participant = participant
            self._broadcast(room, {"type": "participant_joined", "participant": participant.public()}, exclude=participant)

        conn.room = room
        conn.send(
            {
                "type": "welcome",
                "participant": participant.public(),
                "token": participant.token,
                "room": room.room_json(),
                "canvas": room.canvas(),
                "savedRevision": room.saved_revision,
                "participants": [
                    p.public() for p in room.participants.values() if p is not participant and p.conn is not None
                ],
            }
        )
        return room

    def _adopt(self, rec: RoomRecord) -> Room:
        canvas = json.loads(rec.canvas_json)
        room = Room(
            id=rec.id,
            title=rec.title,
            created_at=rec.created_at,
            updated_at=rec.updated_at,
            shapes={s["id"]: s for s in canvas["shapes"]},
            revision=rec.revision,
            saved_revision=rec.revision,
        )
        self.rooms[room.id] = room
        return room

    @staticmethod
    def _match_token(room: Room, token: str | None) -> Participant | None:
        if not token:
            return None
        for p in room.participants.values():
            if hmac.compare_digest(p.token.encode(), token.encode()):
                return p
        return None

    # ------------------------------------------------------------------ disconnect / grace

    def _disconnect(self, conn: Connection) -> None:
        participant = conn.participant
        conn.closing = True
        if participant is None or participant.conn is not conn:
            return  # never joined, or already replaced by a newer connection
        room = conn.room
        participant.conn = None
        conn.participant = None
        if room is None or room.closed:
            return
        self._broadcast(room, {"type": "participant_left", "participantId": participant.id})
        grace = self.settings.grace_period_s
        # A normal closure (1000) means the participant left on purpose, so their
        # seat is freed at once. Drops and refreshes (1001/1006) keep the grace period.
        if grace <= 0 or conn.client_close_code == NORMAL_CLOSURE:
            self._expire(room, participant)
        else:
            participant.grace_handle = asyncio.get_running_loop().call_later(grace, self._expire, room, participant)

    @staticmethod
    def _cancel_grace(participant: Participant) -> None:
        if participant.grace_handle is not None:
            participant.grace_handle.cancel()
            participant.grace_handle = None

    def _expire(self, room: Room, participant: Participant) -> None:
        participant.grace_handle = None
        if participant.conn is not None or room.participants.get(participant.id) is not participant:
            return
        del room.participants[participant.id]
        if not room.participants and not room.closed:
            self._spawn(self._release(room))

    async def _release(self, room: Room) -> None:
        """Flush and drop an empty room from memory. Never drops a dirty room."""
        await self._flush(room)
        if room.participants or room.closed or room.ending:
            return
        if room.revision > room.saved_revision:
            return  # flush failed; the retry timer calls back in here once it succeeds
        room.closed = True
        self._cancel_save_timer(room)
        if self.rooms.get(room.id) is room:
            del self.rooms[room.id]

    # ------------------------------------------------------------------ message handling

    def _invalid_message(self, conn: Connection, message: str) -> None:
        conn.send({"type": "error", "code": "invalid_message", "message": message})

    def _handle_text(self, conn: Connection, room: Room, text: str) -> None:
        try:
            msg = parse_json(text)
        except (ValueError, RecursionError):
            return self._invalid_message(conn, "message is not valid JSON")
        if not isinstance(msg, dict):
            return self._invalid_message(conn, "message must be a JSON object")
        kind = msg.get("type")
        if kind == "op":
            self._handle_op(conn, room, msg)
        elif kind == "cursor":
            self._handle_cursor(conn, room, msg)
        elif kind == "end_session":
            self._spawn(self._end_session(room, conn))
        else:
            self._invalid_message(conn, "unknown message type")

    def _handle_op(self, conn: Connection, room: Room, msg: dict[str, Any]) -> None:
        client_op_id = msg.get("clientOpId")
        if not isinstance(client_op_id, str) or not 1 <= len(client_op_id) <= 64 or "op" not in msg:
            return self._invalid_message(conn, "op message needs clientOpId (1-64 chars) and op")
        participant = conn.participant
        if participant is None:
            return
        if room.ending or room.closed:
            conn.send(
                {"type": "op_rejected", "clientOpId": client_op_id, "code": "room_completed", "message": "this session has ended"}
            )
            return
        result = apply_op(room.shapes, msg["op"])
        if not isinstance(result, AppliedOp):
            conn.send(
                {"type": "op_rejected", "clientOpId": client_op_id, "code": result.code, "message": result.message}
            )
            return
        room.revision += 1
        room.updated_at = utc_now()
        self._broadcast(
            room,
            {
                "type": "op",
                "revision": room.revision,
                "op": result.op,
                "participantId": participant.id,
                "clientOpId": client_op_id,
            },
        )
        self._schedule_save(room, self.settings.save_debounce_s)

    def _handle_cursor(self, conn: Connection, room: Room, msg: dict[str, Any]) -> None:
        position = msg.get("position", ...)
        if position is not None:
            if (
                not isinstance(position, dict)
                or set(position) != {"x", "y"}
                or not is_number(position["x"])
                or not is_number(position["y"])
            ):
                return self._invalid_message(conn, "cursor position must be null or {x, y} with finite numbers")
        participant = conn.participant
        if participant is None:
            return
        self._broadcast(
            room,
            {
                "type": "cursor",
                "participantId": participant.id,
                "name": participant.name,
                "color": participant.color,
                "position": position,
            },
            exclude=participant,
        )

    def _broadcast(self, room: Room, message: dict[str, Any], exclude: Participant | None = None) -> None:
        text = dumps(message)
        for p in room.participants.values():
            if p is not exclude and p.conn is not None:
                p.conn.send_text(text)

    # ------------------------------------------------------------------ persistence

    def _schedule_save(self, room: Room, delay: float) -> None:
        self._cancel_save_timer(room)
        if room.closed or self._stopping:
            return
        room.save_handle = asyncio.get_running_loop().call_later(delay, self._on_save_timer, room)

    @staticmethod
    def _cancel_save_timer(room: Room) -> None:
        if room.save_handle is not None:
            room.save_handle.cancel()
            room.save_handle = None

    def _on_save_timer(self, room: Room) -> None:
        room.save_handle = None
        self._spawn(self._timed_save(room))

    async def _timed_save(self, room: Room) -> None:
        if room.closed or room.ending:
            return
        if await self._flush(room) and not room.participants:
            await self._release(room)

    async def _flush(self, room: Room) -> bool:
        """Write the current canvas if it is newer than the last snapshot. True when clean afterwards."""
        async with room.lock:
            if room.revision <= room.saved_revision:
                return True
            revision = room.revision
            payload = canvas_json(revision, room.shapes)
            updated_at = room.updated_at
            try:
                await asyncio.to_thread(self.db.save_snapshot, room.id, payload, revision, updated_at)
            except Exception as exc:
                log.warning("snapshot save failed for room %s: %s", room.id, exc)
                if not room.closed:
                    self._broadcast(room, {"type": "save_failed", "message": "could not save the canvas; retrying"})
                    if not room.ending:
                        self._schedule_save(room, self.settings.save_retry_s)
                return False
            room.saved_revision = max(room.saved_revision, revision)
            if not room.closed:
                self._broadcast(room, {"type": "saved", "revision": revision})
            return True

    # ------------------------------------------------------------------ ending a session

    async def _end_session(self, room: Room, conn: Connection) -> None:
        if room.ending or room.closed:
            return
        room.ending = True  # from here on ops are rejected, so the revision below is final
        self._cancel_save_timer(room)
        completed_at = utc_now()
        try:
            async with room.lock:
                revision = room.revision
                payload = canvas_json(revision, room.shapes)
                await asyncio.to_thread(self.db.complete_room, room.id, payload, revision, completed_at)
        except Exception as exc:
            log.warning("could not complete room %s: %s", room.id, exc)
            room.ending = False
            conn.send({"type": "error", "code": "save_failed", "message": "could not save the canvas; session not ended"})
            if room.revision > room.saved_revision:
                self._schedule_save(room, self.settings.save_retry_s)
            return
        room.saved_revision = revision
        room.closed = True
        self._completed_ids.add(room.id)
        if self.rooms.get(room.id) is room:
            del self.rooms[room.id]
        final = {
            "type": "session_ended",
            "room": room.room_json("completed", completed_at),
            "canvas": room.canvas(),
        }
        for p in list(room.participants.values()):
            self._cancel_grace(p)
            if p.conn is not None:
                p.conn.send(final)
                p.conn.close(CLOSE_ROOM_COMPLETED)
        room.participants.clear()

    # ------------------------------------------------------------------ lifecycle

    def _spawn(self, coro: Any) -> None:
        task = asyncio.get_running_loop().create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._task_done)

    def _task_done(self, task: asyncio.Task[Any]) -> None:
        self._tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            log.error("background task failed", exc_info=task.exception())

    async def shutdown(self) -> None:
        """Flush every dirty room once and stop all timers."""
        self._stopping = True
        for room in list(self.rooms.values()):
            self._cancel_save_timer(room)
            for p in room.participants.values():
                self._cancel_grace(p)
        # Let in-flight saves/completions finish before the final flush pass.
        if self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)
        for room in list(self.rooms.values()):
            if not room.closed:
                await self._flush(room)
