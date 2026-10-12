from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from app.canvas import MAX_SHAPES, AppliedOp, Rejection, apply_op, parse_json

FIXTURE = json.loads((Path(__file__).resolve().parents[2] / "shared" / "op-validation-cases.json").read_text())
CASES = FIXTURE["cases"]


def base_shapes() -> dict:
    return {s["id"]: copy.deepcopy(s) for s in copy.deepcopy(FIXTURE["baseCanvas"]["shapes"])}


def test_fixture_loaded():
    # Guards against a silently empty parametrization (e.g. a broken fixture path).
    assert len(CASES) >= 60


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_shared_fixture(case):
    shapes = base_shapes()
    before = copy.deepcopy(shapes)
    op = copy.deepcopy(case["op"])
    result = apply_op(shapes, op)

    if case["expect"] == "accepted":
        assert isinstance(result, AppliedOp), result
        if "expectShape" in case:
            expected = case["expectShape"]
            assert result.shape == expected
            assert shapes[expected["id"]] == expected
            if case["op"]["kind"] == "create":
                assert list(shapes)[-1] == expected["id"]
                assert result.op == {"kind": "create", "shape": expected}
            else:
                assert list(shapes) == list(before), "update must keep z-order"
                assert result.op == case["op"]
        else:
            assert case["op"]["kind"] == "delete"
            assert case["op"]["id"] not in shapes
            assert list(shapes) == [i for i in before if i != case["op"]["id"]]
            assert result.op == case["op"] and result.shape is None
    else:
        code = case["expect"]["rejected"]
        assert isinstance(result, Rejection), result
        assert result.code == code
        assert shapes == before, "a rejected op must not mutate the canvas"
        assert list(shapes) == list(before)


def test_canvas_full_rejects_create_but_not_other_ops():
    shapes = {f"s{i}": {**base_shapes()["r1"], "id": f"s{i}"} for i in range(MAX_SHAPES)}
    new = {**base_shapes()["r1"], "id": "extra"}
    result = apply_op(shapes, {"kind": "create", "shape": new})
    assert isinstance(result, Rejection) and result.code == "canvas_full"
    assert len(shapes) == MAX_SHAPES
    assert isinstance(apply_op(shapes, {"kind": "update", "id": "s0", "patch": {"x": 5}}), AppliedOp)
    assert isinstance(apply_op(shapes, {"kind": "delete", "id": "s0"}), AppliedOp)
    assert isinstance(apply_op(shapes, {"kind": "create", "shape": new}), AppliedOp)


def test_check_order_invalid_op_beats_canvas_full_and_duplicate_beats_full():
    shapes = {f"s{i}": {**base_shapes()["r1"], "id": f"s{i}"} for i in range(MAX_SHAPES)}
    bad = {**base_shapes()["r1"], "id": "extra", "x": "1"}
    assert apply_op(shapes, {"kind": "create", "shape": bad}).code == "invalid_op"
    dup = {**base_shapes()["r1"], "id": "s1"}
    assert apply_op(shapes, {"kind": "create", "shape": dup}).code == "duplicate_id"


def test_canvas_full_beats_invalid_binding():
    shapes = {f"s{i}": {**base_shapes()["r1"], "id": f"s{i}"} for i in range(MAX_SHAPES)}
    arrow = {"id": "a", "type": "arrow", "x1": 0, "y1": 0, "x2": 1, "y2": 1, "stroke": "#000000",
             "start": {"shapeId": "nope"}, "end": None}
    assert apply_op(shapes, {"kind": "create", "shape": arrow}).code == "canvas_full"


@pytest.mark.parametrize("literal", ["NaN", "Infinity", "-Infinity"])
def test_parse_json_rejects_nonfinite_literals(literal):
    with pytest.raises(ValueError):
        parse_json('{"x": %s}' % literal)


def test_overflowing_float_and_huge_int_are_out_of_range():
    shapes = base_shapes()
    for value in (parse_json("1e999"), 10**400, -(10**400), float("nan"), float("inf")):
        shape = {**shapes["r1"], "id": "n1", "x": value}
        result = apply_op(shapes, {"kind": "create", "shape": shape})
        assert isinstance(result, Rejection) and result.code == "invalid_op", value


def test_bool_is_not_a_number_anywhere():
    shapes = base_shapes()
    assert apply_op(shapes, {"kind": "update", "id": "t1", "patch": {"fontSize": True}}).code == "invalid_op"
    assert apply_op(shapes, {"kind": "update", "id": "r1", "patch": {"width": False}}).code == "invalid_op"


def test_connector_with_deleted_target_can_still_move_but_not_rebind_to_it():
    shapes = base_shapes()
    assert isinstance(apply_op(shapes, {"kind": "delete", "id": "r1"}), AppliedOp)
    assert shapes["l1"]["start"] == {"shapeId": "r1"}, "server never rewrites bindings"
    assert isinstance(apply_op(shapes, {"kind": "update", "id": "l1", "patch": {"x1": 3}}), AppliedOp)
    result = apply_op(shapes, {"kind": "update", "id": "l1", "patch": {"start": {"shapeId": "r1"}}})
    assert result.code == "invalid_binding"


def test_update_echoes_exactly_the_patch_and_does_not_alias_input():
    shapes = base_shapes()
    patch = {"x": 9}
    result = apply_op(shapes, {"kind": "update", "id": "r1", "patch": patch})
    assert result.op == {"kind": "update", "id": "r1", "patch": {"x": 9}}
    patch["x"] = 1234
    assert shapes["r1"]["x"] == 9


def test_binding_shape_id_must_be_a_valid_id():
    shapes = base_shapes()
    arrow = {"id": "a", "type": "arrow", "x1": 0, "y1": 0, "x2": 1, "y2": 1, "stroke": "#000000",
             "start": {"shapeId": 5}, "end": None}
    assert apply_op(shapes, {"kind": "create", "shape": arrow}).code == "invalid_op"
