"""Serves the built frontend (`frontend/dist`) from the API process, so one container runs the app.

Enabled by SDI_STATIC_DIR. The frontend only answers requests no API route matched, so it can
never shadow an API path, and unknown /api/ and /ws/ paths keep their JSON 404s.
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

# Paths that must 404 rather than fall back to index.html: a script tag pointing at a missing
# asset should fail loudly, not receive HTML.
NO_FALLBACK_PATHS = ("/api", "/ws", "/assets")
NO_FALLBACK_PREFIXES = tuple(f"{p}/" for p in NO_FALLBACK_PATHS)


class HashedAssets(StaticFiles):
    # Vite puts a content hash in every file name under assets/, so a URL's content never changes.
    def file_response(
        self, full_path: str | os.PathLike[str], stat_result: os.stat_result, scope: Scope, status_code: int = 200
    ) -> Response:
        response = super().file_response(full_path, stat_result, scope, status_code)
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


class Frontend:
    def __init__(self, root: Path):
        root = root.resolve()
        self.index = root / "index.html"
        if not self.index.is_file():
            raise RuntimeError(f"SDI_STATIC_DIR has no index.html: {root} (build the frontend first)")
        self.assets_dir = root / "assets"
        # The build never changes while the server runs, so the file list is fixed. Looking paths
        # up in it, rather than on disk, rules out traversal outside the build directory.
        self.files = {
            p.relative_to(root).as_posix(): p
            for p in root.rglob("*")
            if p.is_file() and not p.is_relative_to(self.assets_dir)
        }

    def mount(self, app: FastAPI) -> None:
        app.mount("/assets", HashedAssets(directory=self.assets_dir, check_dir=False), name="assets")

    def response_for(self, request: Request) -> Response | None:
        """What to send instead of a 404, or None to keep the 404."""
        path = request.scope["path"]
        # Strip uvicorn's --root-path, but not the "/assets" a mount adds to root_path when its 404
        # is raised: Starlette keeps the app-level prefix in app_root_path for that reason.
        prefix = request.scope.get("app_root_path", request.scope.get("root_path", ""))
        if prefix and path.startswith(f"{prefix}/"):
            path = path[len(prefix):]
        if request.method not in ("GET", "HEAD") or path in NO_FALLBACK_PATHS or path.startswith(NO_FALLBACK_PREFIXES):
            return None
        file = self.files.get(path.lstrip("/"))
        if file is not None and file != self.index:
            return FileResponse(file)
        # Client-side routes such as /r/<id> get the app shell; the client router shows its own
        # not-found page. no-cache makes browsers pick up a new deploy's asset names.
        return FileResponse(self.index, headers={"Cache-Control": "no-cache"})
