from __future__ import annotations

import re

import pytest

from conftest import create_room, db_row, join, op_msg, create_op, rect


def assert_error(resp, status: int, code: str) -> None:
    assert resp.status_code == status, resp.text
    body = resp.json()
    assert set(body) == {"error"}
    assert body["error"]["code"] == code
    assert isinstance(body["error"]["message"], str) and body["error"]["message"]


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json() == {"status": "ok"}


def test_create_room_returns_room_with_unguessable_id(client):
    r = client.post("/api/rooms", json={"title": "  Design a URL Shortener  "})
    assert r.status_code == 201
    room = r.json()
    assert set(room) == {"id", "title", "status", "createdAt", "updatedAt", "completedAt"}
    assert re.fullmatch(r"[A-Za-z0-9_-]{22}", room["id"])
    assert room["title"] == "Design a URL Shortener"
    assert room["status"] == "active" and room["completedAt"] is None
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", room["createdAt"])
    assert create_room(client) != room["id"]


def test_title_of_exactly_120_chars_is_accepted_after_trim(client):
    r = client.post("/api/rooms", json={"title": " " + "a" * 120 + " "})
    assert r.status_code == 201 and r.json()["title"] == "a" * 120


@pytest.mark.parametrize(
    "body",
    [{}, {"title": 5}, {"title": None}, {"title": ["x"]}, {"title": ""}, {"title": "   \n\t"}, {"title": "a" * 121}],
    ids=["missing", "number", "null", "list", "empty", "blank", "too-long"],
)
def test_invalid_title(client, body):
    assert_error(client.post("/api/rooms", json=body), 422, "invalid_title")


@pytest.mark.parametrize(
    "content",
    [b"[]", b'"x"', b"5", b"null", b"not json", b"", b'{"title": NaN}x', b'{"title": "ok", '],
    ids=["array", "string", "number", "null", "garbage", "empty", "trailing", "truncated"],
)
def test_body_that_is_not_a_json_object_is_invalid_request(client, content):
    r = client.post("/api/rooms", content=content, headers={"content-type": "application/json"})
    assert_error(r, 422, "invalid_request")


def test_lone_surrogate_title_is_rejected_not_a_500(client):
    r = client.post("/api/rooms", content=b'{"title": "bad \\ud800"}', headers={"content-type": "application/json"})
    assert_error(r, 422, "invalid_title")


def test_get_room_returns_room_and_empty_canvas(client):
    room_id = create_room(client, "T")
    r = client.get(f"/api/rooms/{room_id}")
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == room_id and body["title"] == "T" and body["status"] == "active"
    assert body["canvas"] == {"revision": 0, "shapes": []}


def test_get_unknown_room_is_404_with_error_body(client):
    assert_error(client.get("/api/rooms/nope"), 404, "room_not_found")


def test_unknown_route_and_wrong_method_use_the_error_format(client):
    assert_error(client.get("/api/nothing"), 404, "not_found")
    assert_error(client.delete("/api/rooms"), 405, "method_not_allowed")


def test_get_live_room_returns_in_memory_canvas_newer_than_snapshot(make_client, make_settings):
    settings = make_settings(save_debounce_s=60.0)
    client = make_client(save_debounce_s=60.0)
    room_id = create_room(client)
    with join(client, room_id) as ws:
        ws.send(op_msg(create_op(rect("r1"))))
        assert ws.recv_type("op")["revision"] == 1
        body = client.get(f"/api/rooms/{room_id}").json()
        assert body["canvas"]["revision"] == 1
        assert [s["id"] for s in body["canvas"]["shapes"]] == ["r1"]
        assert db_row(settings.db_path, room_id)["revision"] == 0, "debounce has not fired yet"
