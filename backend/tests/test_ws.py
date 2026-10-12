from __future__ import annotations

import json
import time

import pytest

from conftest import WS, create_op, create_room, db_row, join, op_msg, rect, wait_for

COLORS = ["#e8590c", "#1c7ed6"]


def expect_rejected_join(client, path: str, code: int, error_code: str) -> None:
    with client.websocket_connect(path) as session:
        ws = WS(session)
        msgs, close = ws.recv_close()
        assert close == code
        assert msgs[0]["type"] == "error" and msgs[0]["code"] == error_code
        assert len(msgs) == 1


# ---------------------------------------------------------------- join / welcome


def test_join_receives_welcome(client):
    room_id = create_room(client, "Title")
    with join(client, room_id, "Ada") as ws:
        w = ws.welcome
        assert set(w) == {"type", "participant", "token", "room", "canvas", "savedRevision", "participants"}
        assert w["participant"]["name"] == "Ada"
        assert w["participant"]["id"].startswith("p_")
        assert w["participant"]["color"] == COLORS[0]
        assert len(w["token"]) >= 32  # 24 random bytes -> 32 url-safe chars, >128 bits
        assert w["room"]["id"] == room_id and w["room"]["status"] == "active" and w["room"]["title"] == "Title"
        assert w["canvas"] == {"revision": 0, "shapes": []}
        assert w["savedRevision"] == 0
        assert w["participants"] == []


def test_name_is_trimmed(client):
    room_id = create_room(client)
    with join(client, room_id, "%20%20Ada%20%20") as ws:
        assert ws.welcome["participant"]["name"] == "Ada"


def test_second_participant_gets_other_colour_and_both_are_notified(client):
    room_id = create_room(client)
    with join(client, room_id, "Ada") as a, join(client, room_id, "Bob") as b:
        assert b.welcome["participant"]["color"] == COLORS[1]
        assert b.welcome["participants"] == [a.welcome["participant"]]
        joined = a.recv_type("participant_joined")
        assert joined["participant"] == b.welcome["participant"]
        assert "token" not in joined["participant"]


@pytest.mark.parametrize("query", ["", "name=", "name=%20%20", "name=" + "x" * 41], ids=["missing", "empty", "blank", "too-long"])
def test_invalid_name_closes_4000(client, query):
    room_id = create_room(client)
    expect_rejected_join(client, f"/ws/rooms/{room_id}?{query}", 4000, "invalid_name")


def test_name_of_40_chars_is_accepted(client):
    room_id = create_room(client)
    with join(client, room_id, "x" * 40) as ws:
        assert ws.welcome["participant"]["name"] == "x" * 40


def test_unknown_room_closes_4004(client):
    expect_rejected_join(client, "/ws/rooms/doesnotexist?name=Ada", 4004, "room_not_found")
    expect_rejected_join(client, "/ws/rooms/abc%00def?name=Ada", 4004, "room_not_found")


def test_third_participant_gets_room_full_4003(client):
    room_id = create_room(client)
    with join(client, room_id, "Ada"), join(client, room_id, "Bob"):
        expect_rejected_join(client, f"/ws/rooms/{room_id}?name=Cy", 4003, "room_full")


def test_unknown_token_is_treated_as_a_new_join(client):
    room_id = create_room(client)
    with join(client, room_id, "Ada", token="not-a-real-token") as ws:
        assert ws.welcome["token"] != "not-a-real-token"


# ---------------------------------------------------------------- ops


def test_two_participants_see_ops_in_order_and_sender_gets_client_op_id(client):
    room_id = create_room(client)
    with join(client, room_id, "Ada") as a, join(client, room_id, "Bob") as b:
        a.send(op_msg(create_op(rect("r1")), "c_a1"))
        b.send(op_msg(create_op(rect("r2")), "c_b1"))
        a.send(op_msg({"kind": "update", "id": "r1", "patch": {"x": 5}}, "c_a2"))

        def ops(ws: WS, n: int):
            out = []
            while len(out) < n:
                m = ws.recv()
                if m["type"] == "op":
                    out.append(m)
            return out

        a_ops, b_ops = ops(a, 3), ops(b, 3)
        assert a_ops == b_ops, "every participant (sender included) gets the identical ordered stream"
        assert [m["revision"] for m in a_ops] == [1, 2, 3]
        by_client_id = {m["clientOpId"]: m for m in a_ops}
        assert set(by_client_id) == {"c_a1", "c_b1", "c_a2"}
        assert by_client_id["c_a1"]["participantId"] == a.welcome["participant"]["id"]
        assert by_client_id["c_b1"]["participantId"] == b.welcome["participant"]["id"]
        assert by_client_id["c_a2"]["op"] == {"kind": "update", "id": "r1", "patch": {"x": 5}}
        assert by_client_id["c_a1"]["op"] == {"kind": "create", "shape": rect("r1")}


def test_op_rejected_goes_to_sender_and_consumes_no_revision(client):
    room_id = create_room(client)
    with join(client, room_id, "Ada") as a, join(client, room_id, "Bob"):
        a.send(op_msg({"kind": "delete", "id": "ghost"}, "c_bad"))
        rejected = a.recv_type("op_rejected")
        assert rejected["clientOpId"] == "c_bad" and rejected["code"] == "shape_not_found" and rejected["message"]
        a.send(op_msg(create_op(rect("r1")), "c_ok"))
        assert a.recv_type("op")["revision"] == 1


def test_rejected_op_is_never_seen_by_the_other_participant(client):
    room_id = create_room(client)
    with join(client, room_id, "Ada") as a, join(client, room_id, "Bob") as b:
        a.send(op_msg({"kind": "bogus"}, "c_bad"))
        a.recv_type("op_rejected")
        seen = b.sync()
        assert [m for m in seen if m["type"] in ("op", "op_rejected")] == []


def test_last_write_wins_in_server_order(client):
    room_id = create_room(client)
    with join(client, room_id, "Ada") as a, join(client, room_id, "Bob") as b:
        a.send(op_msg(create_op(rect("r1")), "c_create"))
        a.recv_type("op")
        b.recv_type("op")
        a.send(op_msg({"kind": "update", "id": "r1", "patch": {"x": 111, "label": "from-a"}}, "c_a"))
        b.send(op_msg({"kind": "update", "id": "r1", "patch": {"x": 222}}, "c_b"))
        a_updates = [a.recv_type("op"), a.recv_type("op")]
        b_updates = [b.recv_type("op"), b.recv_type("op")]
        assert a_updates == b_updates
        assert [m["revision"] for m in a_updates] == [2, 3]

        # whichever update the server ordered last wins; a patch only overwrites its own fields
        expected = dict(rect("r1"))
        for m in a_updates:
            expected.update(m["op"]["patch"])
        canvas = client.get(f"/api/rooms/{room_id}").json()["canvas"]
        assert canvas["revision"] == 3
        assert canvas["shapes"] == [expected]
        assert canvas["shapes"][0]["x"] == a_updates[-1]["op"]["patch"]["x"]


def test_cursor_goes_to_other_participant_only(client):
    room_id = create_room(client)
    with join(client, room_id, "Ada") as a, join(client, room_id, "Bob") as b:
        a.send({"type": "cursor", "position": {"x": 10.5, "y": -3}})
        cursor = b.recv_type("cursor")
        assert cursor == {
            "type": "cursor",
            "participantId": a.welcome["participant"]["id"],
            "name": "Ada",
            "color": COLORS[0],
            "position": {"x": 10.5, "y": -3},
        }
        a.send({"type": "cursor", "position": None})
        assert b.recv_type("cursor")["position"] is None
        assert [m for m in a.sync() if m["type"] == "cursor"] == []


def test_cursor_is_not_persisted(client, make_settings):
    room_id = create_room(client)
    with join(client, room_id, "Ada") as a, join(client, room_id, "Bob") as b:
        a.send({"type": "cursor", "position": {"x": 1, "y": 2}})
        b.recv_type("cursor")
        a.sync()
    assert client.get(f"/api/rooms/{room_id}").json()["canvas"]["revision"] == 0


# ---------------------------------------------------------------- malformed messages


@pytest.mark.parametrize(
    "payload",
    [
        "not json",
        "[]",
        '"op"',
        "null",
        "{}",
        '{"type": "teleport"}',
        '{"type": 5}',
        '{"type": "op", "op": {"kind": "delete", "id": "x"}}',
        '{"type": "op", "clientOpId": "", "op": {"kind": "delete", "id": "x"}}',
        '{"type": "op", "clientOpId": 7, "op": {"kind": "delete", "id": "x"}}',
        '{"type": "op", "clientOpId": "%s", "op": {"kind": "delete", "id": "x"}}' % ("c" * 65),
        '{"type": "op", "clientOpId": "c_1"}',
        '{"type": "cursor"}',
        '{"type": "cursor", "position": "10,20"}',
        '{"type": "cursor", "position": {"x": "1", "y": 2}}',
        '{"type": "cursor", "position": {"x": true, "y": 2}}',
        '{"type": "cursor", "position": {"x": 1}}',
        '{"type": "cursor", "position": {"x": NaN, "y": 2}}',
        '{"type": "cursor", "position": {"x": 1e999, "y": 2}}',
        '{"type": "cursor", "position": {"x": Infinity, "y": 2}}',
    ],
)
def test_malformed_messages_yield_invalid_message_and_keep_connection_open(client, payload):
    room_id = create_room(client)
    with join(client, room_id, "Ada") as ws:
        ws.send_text(payload)
        err = ws.recv()
        assert err["type"] == "error" and err["code"] == "invalid_message" and err["message"]
        ws.send(op_msg(create_op(rect("r1"))))
        assert ws.recv_type("op")["revision"] == 1, "connection must still be usable"


def test_binary_frame_is_invalid_message(client):
    room_id = create_room(client)
    with join(client, room_id, "Ada") as ws:
        ws.session.send_bytes(b"\x00\x01")
        err = ws.recv()
        assert err["code"] == "invalid_message"
        assert ws.sync() == []


def test_nan_in_op_is_not_accepted(client):
    room_id = create_room(client)
    with join(client, room_id, "Ada") as ws:
        ws.send_text(
            '{"type":"op","clientOpId":"c_1","op":{"kind":"update","id":"r1","patch":{"x":NaN}}}'
        )
        assert ws.recv()["code"] == "invalid_message"


# ---------------------------------------------------------------- reconnect / slots


def test_reconnect_within_grace_reclaims_identity_and_gets_current_canvas(make_client):
    client = make_client(grace_period_s=30.0)
    room_id = create_room(client)
    with join(client, room_id, "Bob") as b:
        with join(client, room_id, "Ada") as a:
            a_id, a_token, a_color = a.welcome["participant"]["id"], a.welcome["token"], a.welcome["participant"]["color"]
            b.recv_type("participant_joined")
            a.drop()
        assert b.recv_type("participant_left")["participantId"] == a_id
        b.send(op_msg(create_op(rect("r1"))))
        b.recv_type("op")

        # a third person cannot take the reserved slot
        expect_rejected_join(client, f"/ws/rooms/{room_id}?name=Cy", 4003, "room_full")

        with join(client, room_id, "Ada2", token=a_token) as a2:
            w = a2.welcome
            assert w["participant"] == {"id": a_id, "name": "Ada2", "color": a_color}
            assert w["token"] == a_token
            assert [s["id"] for s in w["canvas"]["shapes"]] == ["r1"] and w["canvas"]["revision"] == 1
            assert w["participants"] == [b.welcome["participant"]]
            joined = b.recv_type("participant_joined")
            assert joined["participant"]["id"] == a_id and joined["participant"]["name"] == "Ada2"


def test_slot_released_after_grace_expiry(make_client):
    client = make_client(grace_period_s=0.2)
    manager = client.app.state.manager
    room_id = create_room(client)
    with join(client, room_id, "Bob") as b:
        with join(client, room_id, "Ada") as a:
            a_id, old_token = a.welcome["participant"]["id"], a.welcome["token"]
            a_color = a.welcome["participant"]["color"]
            b.recv_type("participant_joined")
        b.recv_type("participant_left")
        wait_for(lambda: a_id not in manager.rooms[room_id].participants, what="grace expiry")
        with join(client, room_id, "Cy") as c:
            assert c.welcome["participant"]["id"] != a_id
            assert c.welcome["participant"]["color"] == a_color, "freed colour is reused"
        # the expired token no longer reclaims anything
        wait_for(lambda: len(manager.rooms[room_id].participants) == 1, what="Cy's grace expiry")
        with join(client, room_id, "Ada", token=old_token) as again:
            assert again.welcome["participant"]["id"] != a_id and again.welcome["token"] != old_token


def test_refresh_race_second_connection_replaces_first(client):
    room_id = create_room(client)
    with join(client, room_id, "Bob") as b:
        with join(client, room_id, "Ada") as a1:
            b.recv_type("participant_joined")
            token = a1.welcome["token"]
            a_id = a1.welcome["participant"]["id"]
            with join(client, room_id, "Ada", token=token) as a2:
                assert a2.welcome["participant"]["id"] == a_id and a2.welcome["token"] == token
                msgs, close = a1.recv_close()
                assert close == 4001
                assert msgs[-1]["type"] == "error" and msgs[-1]["code"] == "replaced"
                # the replaced socket's teardown must not evict the participant
                a2.send(op_msg(create_op(rect("r1"))))
                assert a2.recv_type("op")["revision"] == 1
                b_seen = b.sync()
                assert not [m for m in b_seen if m["type"] in ("participant_left", "participant_joined")]
                assert any(m["type"] == "op" for m in b_seen)


def test_disconnect_notifies_other_participant(client):
    room_id = create_room(client)
    with join(client, room_id, "Bob") as b:
        with join(client, room_id, "Ada") as a:
            a_id = a.welcome["participant"]["id"]
        assert b.recv_type("participant_left")["participantId"] == a_id


# ---------------------------------------------------------------- persistence


def test_debounced_save_writes_sqlite_and_broadcasts_saved(make_client, make_settings):
    client = make_client()
    settings = make_settings()
    room_id = create_room(client)
    with join(client, room_id, "Ada") as a, join(client, room_id, "Bob") as b:
        a.send(op_msg(create_op(rect("r1"))))
        a.send(op_msg({"kind": "update", "id": "r1", "patch": {"x": 9}}))
        saved_a = a.recv_type("saved")
        saved_b = b.recv_type("saved")
        assert saved_a == saved_b
        assert saved_a["revision"] in (1, 2)
        wait_for(lambda: db_row(settings, room_id)["revision"] == 2, what="revision 2 in sqlite")
        row = db_row(settings, room_id)
        canvas = json.loads(row["canvas_json"])
        assert canvas["revision"] == 2 and row["status"] == "active"
        assert [s["id"] for s in canvas["shapes"]] == ["r1"] and canvas["shapes"][0]["x"] == 9


def test_burst_of_ops_coalesces_into_one_save_with_latest_revision(make_client):
    client = make_client(save_debounce_s=0.3)
    room_id = create_room(client)
    with join(client, room_id, "Ada") as a:
        for i in range(10):
            a.send(op_msg(create_op(rect(f"s{i}")), f"c_{i}"))
        saved = a.recv_type("saved")
        assert saved["revision"] == 10


def test_snapshot_survives_app_restart(make_settings):
    from fastapi.testclient import TestClient
    from app.main import create_app

    settings = make_settings()
    with TestClient(create_app(settings)) as c1:
        room_id = create_room(c1, "Persistent")
        with join(c1, room_id, "Ada") as a:
            a.send(op_msg(create_op(rect("r1"))))
            a.send(op_msg(create_op(rect("r2"))))
            a.recv_type("saved")
            wait_for(lambda: db_row(settings, room_id)["revision"] == 2)

    with TestClient(create_app(settings)) as c2:
        body = c2.get(f"/api/rooms/{room_id}").json()
        assert body["title"] == "Persistent" and body["canvas"]["revision"] == 2
        assert [s["id"] for s in body["canvas"]["shapes"]] == ["r1", "r2"]
        with join(c2, room_id, "Ada") as a:
            assert a.welcome["canvas"] == body["canvas"]
            assert a.welcome["savedRevision"] == 2
            a.send(op_msg(create_op(rect("r3"))))
            assert a.recv_type("op")["revision"] == 3


def test_shutdown_flushes_unsaved_changes(make_settings):
    from fastapi.testclient import TestClient
    from app.main import create_app

    settings = make_settings(save_debounce_s=60.0, grace_period_s=60.0)
    with TestClient(create_app(settings)) as c1:
        room_id = create_room(c1)
        with join(c1, room_id, "Ada") as a:
            a.send(op_msg(create_op(rect("r1"))))
            a.recv_type("op")
            a.drop()
        # room stays in memory (reserved slot) with an unsaved change when the app stops
        assert db_row(settings, room_id)["revision"] == 0
    assert db_row(settings, room_id)["revision"] == 1


def test_empty_room_cleanup_flushes_and_releases_memory_without_completing(make_client, make_settings):
    client = make_client(save_debounce_s=60.0, grace_period_s=0.1)
    settings = make_settings()
    manager = client.app.state.manager
    room_id = create_room(client)
    with join(client, room_id, "Ada") as a:
        a.send(op_msg(create_op(rect("r1"))))
        a.recv_type("op")
        assert room_id in manager.rooms
    wait_for(lambda: room_id not in manager.rooms, what="room released from memory")
    row = db_row(settings, room_id)
    assert row["revision"] == 1, "pending snapshot was flushed before release"
    assert row["status"] == "active" and row["completed_at"] is None
    body = client.get(f"/api/rooms/{room_id}").json()
    assert body["status"] == "active" and body["canvas"]["revision"] == 1
    with join(client, room_id, "Ada") as again:  # room can be rejoined, state reloaded from SQLite
        assert again.welcome["canvas"]["revision"] == 1 and again.welcome["savedRevision"] == 1


def test_room_with_reserved_slot_is_not_released(make_client):
    client = make_client(grace_period_s=30.0)
    manager = client.app.state.manager
    room_id = create_room(client)
    with join(client, room_id, "Ada") as a:
        a.drop()
    time.sleep(0.2)
    assert room_id in manager.rooms


def test_normal_close_frees_the_seat_without_grace(make_client):
    client = make_client(grace_period_s=30.0)
    manager = client.app.state.manager
    room_id = create_room(client)
    with join(client, room_id, "Bob") as b:
        with join(client, room_id, "Ada") as a:
            a_id = a.welcome["participant"]["id"]
            b.recv_type("participant_joined")
        # Leaving the block sends close code 1000: Ada left on purpose.
        assert b.recv_type("participant_left")["participantId"] == a_id
        wait_for(lambda: a_id not in manager.rooms[room_id].participants, what="immediate release")
        with join(client, room_id, "Cy") as c:
            assert c.welcome["participant"]["id"] != a_id


def test_save_failure_broadcasts_save_failed_and_retries(make_client):
    client = make_client(save_debounce_s=0.05, save_retry_s=0.1)
    db = client.app.state.db
    real = db.save_snapshot
    calls = {"n": 0}

    def flaky(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] <= 2:
            raise OSError("disk on fire")
        return real(*args, **kwargs)

    db.save_snapshot = flaky
    room_id = create_room(client)
    with join(client, room_id, "Ada") as a, join(client, room_id, "Bob") as b:
        a.send(op_msg(create_op(rect("r1"))))
        failed = a.recv_type("save_failed")
        assert failed["message"]
        assert b.recv_type("save_failed")
        saved = a.recv_type("saved")
        assert saved["revision"] == 1 and calls["n"] >= 3
        assert b.recv_type("saved")["revision"] == 1


def test_dirty_room_is_not_released_until_save_succeeds(make_client, make_settings):
    client = make_client(save_debounce_s=0.05, save_retry_s=0.1, grace_period_s=0.05)
    settings = make_settings()
    manager = client.app.state.manager
    db = client.app.state.db
    real = db.save_snapshot
    state = {"fail": True}

    def flaky(*args, **kwargs):
        if state["fail"]:
            raise OSError("down")
        return real(*args, **kwargs)

    db.save_snapshot = flaky
    room_id = create_room(client)
    with join(client, room_id, "Ada") as a:
        a.send(op_msg(create_op(rect("r1"))))
        a.recv_type("save_failed")
    time.sleep(0.4)
    assert room_id in manager.rooms, "dirty room must stay in memory"
    state["fail"] = False
    wait_for(lambda: room_id not in manager.rooms, what="release after recovery")
    assert db_row(settings, room_id)["revision"] == 1


def test_snapshot_write_never_replaces_a_higher_revision(make_client, make_settings):
    client = make_client()
    settings = make_settings()
    room_id = create_room(client)
    db = client.app.state.db
    assert db.save_snapshot(room_id, '{"revision":5,"shapes":[]}', 5, "2026-01-01T00:00:00.000Z") is True
    assert db.save_snapshot(room_id, '{"revision":3,"shapes":[]}', 3, "2026-01-01T00:00:00.000Z") is False
    assert db_row(settings, room_id)["revision"] == 5


# ---------------------------------------------------------------- end session


def test_end_session_completes_room_and_closes_everyone_with_4009(client, make_settings):
    settings = make_settings()
    room_id = create_room(client)
    with join(client, room_id, "Ada") as a, join(client, room_id, "Bob") as b:
        a.send(op_msg(create_op(rect("r1"))))
        a.recv_type("op")
        b.recv_type("op")
        b.send({"type": "end_session"})
        for ws in (a, b):
            msgs, close = ws.recv_close()
            assert close == 4009
            ended = [m for m in msgs if m["type"] == "session_ended"]
            assert len(ended) == 1 and msgs[-1] is ended[0], "session_ended is the last message before close"
            assert ended[0]["room"]["status"] == "completed"
            assert ended[0]["room"]["completedAt"]
            assert ended[0]["canvas"]["revision"] == 1
            assert [s["id"] for s in ended[0]["canvas"]["shapes"]] == ["r1"]

    row = db_row(settings, room_id)
    assert row["status"] == "completed" and row["completed_at"] and row["revision"] == 1
    assert client.app.state.manager.rooms.get(room_id) is None

    expect_rejected_join(client, f"/ws/rooms/{room_id}?name=Ada", 4009, "room_completed")
    body = client.get(f"/api/rooms/{room_id}").json()
    assert body["status"] == "completed" and body["completedAt"]
    assert body["canvas"]["revision"] == 1 and [s["id"] for s in body["canvas"]["shapes"]] == ["r1"]


def test_end_session_flushes_pending_changes_even_with_long_debounce(make_client, make_settings):
    client = make_client(save_debounce_s=60.0)
    settings = make_settings()
    room_id = create_room(client)
    with join(client, room_id, "Ada") as a:
        a.send(op_msg(create_op(rect("r1"))))
        a.send(op_msg(create_op(rect("r2"))))
        a.send({"type": "end_session"})
        msgs, close = a.recv_close()
        assert close == 4009
    row = db_row(settings, room_id)
    assert row["status"] == "completed" and json.loads(row["canvas_json"])["revision"] == 2


def test_completed_room_stays_completed_after_restart(make_settings):
    from fastapi.testclient import TestClient
    from app.main import create_app

    settings = make_settings()
    with TestClient(create_app(settings)) as c1:
        room_id = create_room(c1)
        with join(c1, room_id, "Ada") as a:
            a.send({"type": "end_session"})
            a.recv_close()
    with TestClient(create_app(settings)) as c2:
        expect_rejected_join(c2, f"/ws/rooms/{room_id}?name=Ada", 4009, "room_completed")
        assert c2.get(f"/api/rooms/{room_id}").json()["status"] == "completed"


def test_end_session_with_failing_flush_keeps_room_active(client, make_settings):
    settings = make_settings()
    db = client.app.state.db
    real = db.complete_room

    def failing(*args, **kwargs):
        raise OSError("nope")

    db.complete_room = failing
    room_id = create_room(client)
    with join(client, room_id, "Ada") as a, join(client, room_id, "Bob") as b:
        a.send(op_msg(create_op(rect("r1"))))
        a.send({"type": "end_session"})
        err = a.recv_type("error")
        assert err["code"] == "save_failed"
        assert [m for m in b.sync() if m["type"] in ("session_ended", "error")] == []
        assert db_row(settings, room_id)["status"] == "active"

        # still fully usable, and a later attempt succeeds
        a.send(op_msg(create_op(rect("r2")), "c_2"))
        assert a.recv_type("op")["clientOpId"] == "c_2"
        db.complete_room = real
        a.send({"type": "end_session"})
        _, close = a.recv_close()
        assert close == 4009
    assert db_row(settings, room_id)["status"] == "completed"
