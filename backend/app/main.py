from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request, WebSocket
from fastapi.exceptions import RequestValidationError
from fastapi.responses import Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from .canvas import parse_json
from .config import Settings
from .db import Database
from .frontend import Frontend
from .rooms import RoomManager

log = logging.getLogger("sdi")

MAX_TITLE_LEN = 120


def json_response(status_code: int, body: Any) -> Response:
    # json.dumps defaults to ASCII output, which cannot fail on lone surrogates the way UTF-8 can.
    return Response(json.dumps(body, allow_nan=False), status_code=status_code, media_type="application/json")


def error_response(status_code: int, code: str, message: str) -> Response:
    return json_response(status_code, {"error": {"code": code, "message": message}})


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    db = Database(settings.database_url)
    manager = RoomManager(db, settings)
    frontend = Frontend(settings.static_dir) if settings.static_dir is not None else None

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await asyncio.to_thread(db.init_schema)
        yield
        await manager.shutdown()
        db.close()

    app = FastAPI(title="System Design Whiteboard", lifespan=lifespan)
    app.state.settings = settings
    app.state.db = db
    app.state.manager = manager

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException) -> Response:
        if exc.status_code == 404 and frontend is not None:
            page = frontend.response_for(request)
            if page is not None:
                return page
        codes = {404: "not_found", 405: "method_not_allowed"}
        return error_response(exc.status_code, codes.get(exc.status_code, "http_error"), str(exc.detail))

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError) -> Response:
        return error_response(422, "invalid_request", "request validation failed")

    @app.get("/api/health")
    async def health() -> Response:
        return json_response(200, {"status": "ok"})

    @app.post("/api/rooms")
    async def create_room(request: Request) -> Response:
        try:
            body = parse_json(await request.body())
        except (ValueError, RecursionError):
            return error_response(422, "invalid_request", "body must be a JSON object")
        if not isinstance(body, dict):
            return error_response(422, "invalid_request", "body must be a JSON object")
        title = body.get("title")
        if not isinstance(title, str) or not title.strip() or len(title.strip()) > MAX_TITLE_LEN:
            return error_response(422, "invalid_title", f"title must be a string of 1-{MAX_TITLE_LEN} characters")
        title = title.strip()
        if "\x00" in title:  # Postgres text columns cannot store NUL
            return error_response(422, "invalid_title", "title must not contain NUL characters")
        try:
            title.encode("utf-8")
        except UnicodeEncodeError:
            return error_response(422, "invalid_title", "title must be valid unicode text")
        return json_response(201, await manager.create_room(title))

    @app.get("/api/rooms/{room_id}")
    async def get_room(room_id: str) -> Response:
        view = await manager.get_room_view(room_id)
        if view is None:
            return error_response(404, "room_not_found", "room not found")
        return json_response(200, view)

    @app.websocket("/ws/rooms/{room_id}")
    async def room_socket(ws: WebSocket, room_id: str) -> None:
        await manager.serve(ws, room_id, ws.query_params.get("name"), ws.query_params.get("token"))

    if frontend is not None:
        frontend.mount(app)

    return app


app = create_app()
