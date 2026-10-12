from __future__ import annotations

from pathlib import Path

import pytest

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from test_rest import assert_error

INDEX = "<!doctype html><title>app shell</title>"


@pytest.fixture
def dist(tmp_path: Path) -> Path:
    """A minimal stand-in for `npm run build` output, next to a file that must never be served."""
    root = tmp_path / "dist"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text(INDEX)
    (root / "favicon.svg").write_text("<svg/>")
    (root / "assets" / "index-abc123.js").write_text("console.log(1)")
    (tmp_path / "secret.txt").write_text("secret")
    return root


@pytest.fixture
def app_client(make_client, dist):
    return make_client(static_dir=dist)


@pytest.mark.parametrize("path", ["/", "/r/abc_DEF-123", "/no/such/page"])
def test_client_routes_get_the_app_shell(app_client, path):
    r = app_client.get(path)
    assert r.status_code == 200 and r.text == INDEX
    assert r.headers["content-type"].startswith("text/html")
    assert r.headers["cache-control"] == "no-cache"


def test_public_files_and_hashed_assets_are_served(app_client):
    favicon = app_client.get("/favicon.svg")
    assert favicon.status_code == 200 and favicon.text == "<svg/>"
    asset = app_client.get("/assets/index-abc123.js")
    assert asset.status_code == 200 and asset.text == "console.log(1)"
    assert "immutable" in asset.headers["cache-control"]


def test_api_and_asset_errors_are_not_replaced_by_the_app_shell(app_client):
    assert app_client.get("/api/health").json() == {"status": "ok"}
    assert_error(app_client.get("/api/nothing"), 404, "not_found")
    assert_error(app_client.get("/api/rooms/nope"), 404, "room_not_found")
    assert_error(app_client.delete("/api/rooms"), 405, "method_not_allowed")
    assert_error(app_client.get("/assets/missing.js"), 404, "not_found")
    assert_error(app_client.post("/r/abc"), 404, "not_found")
    for path in ("/api", "/ws", "/ws/nothing"):
        assert_error(app_client.get(path), 404, "not_found")


def test_fallback_ignores_the_root_path_prefix(make_settings, dist):
    with TestClient(create_app(make_settings(static_dir=dist)), root_path="/sdi") as client:
        assert client.get("/sdi/favicon.svg").text == "<svg/>"
        assert_error(client.get("/sdi/api/nothing"), 404, "not_found")
        assert client.get("/sdi/r/abc").text == INDEX


# Percent-encoded, because httpx normalizes a literal /../ away before sending.
@pytest.mark.parametrize("path", ["/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt"])
def test_files_outside_the_build_are_never_served(app_client, path):
    assert "secret" not in app_client.get(path).text


def test_missing_build_fails_at_startup(make_settings, tmp_path):
    with pytest.raises(RuntimeError, match="index.html"):
        create_app(make_settings(static_dir=tmp_path / "empty"))


@pytest.mark.parametrize(("value", "expected"), [("/app/static", Path("/app/static")), ("  ", None), (None, None)])
def test_static_dir_comes_from_the_environment(monkeypatch, value, expected):
    monkeypatch.delenv("SDI_STATIC_DIR", raising=False)
    if value is not None:
        monkeypatch.setenv("SDI_STATIC_DIR", value)
    assert Settings.from_env().static_dir == expected
