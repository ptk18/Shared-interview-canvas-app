"""Pure canvas/op logic. No I/O so it can be tested directly against the shared fixture."""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from typing import Any, Callable

MAX_SHAPES = 2000
COORD_LIMIT = 1_000_000

_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")
_COLOR_RE = re.compile(r"#[0-9a-fA-F]{6}")
_BINDABLE_TYPES = frozenset({"rect", "ellipse", "text"})

Shape = dict[str, Any]
Binding = dict[str, str]


@dataclass(frozen=True)
class Rejection:
    code: str
    message: str


@dataclass(frozen=True)
class AppliedOp:
    """`op` is the normalized form to broadcast; `shape` is the resulting shape (None for delete)."""

    op: dict[str, Any]
    shape: Shape | None


class _Invalid(Exception):
    pass


def parse_json(text: str | bytes) -> Any:
    """json.loads that also rejects the NaN/Infinity literals Python accepts by default."""

    def reject_constant(name: str) -> Any:
        raise ValueError(f"invalid JSON constant {name}")

    return json.loads(text, parse_constant=reject_constant)


def is_number(v: Any) -> bool:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return False
    return isinstance(v, int) or math.isfinite(v)


def _number(lo: float, hi: float) -> Callable[[Any], None]:
    def check(v: Any) -> None:
        # Comparing before any float conversion keeps huge ints from raising OverflowError.
        if not is_number(v) or not (lo <= v <= hi):
            raise _Invalid(f"must be a number between {lo:g} and {hi:g}")

    return check


def _color(v: Any) -> None:
    if not isinstance(v, str) or not (v == "transparent" or _COLOR_RE.fullmatch(v)):
        raise _Invalid('must be "transparent" or #rrggbb')


def _string(max_len: int) -> Callable[[Any], None]:
    def check(v: Any) -> None:
        if not isinstance(v, str) or len(v) > max_len:
            raise _Invalid(f"must be a string of at most {max_len} characters")

    return check


def _binding(v: Any) -> None:
    if v is None:
        return
    if not isinstance(v, dict) or set(v) != {"shapeId"}:
        raise _Invalid('must be null or {"shapeId": id}')
    if not isinstance(v["shapeId"], str) or not _ID_RE.fullmatch(v["shapeId"]):
        raise _Invalid("shapeId must be a valid shape id")


_coord = _number(-COORD_LIMIT, COORD_LIMIT)
_box_dim = _number(0, COORD_LIMIT)

_BOX_FIELDS: dict[str, Callable[[Any], None]] = {
    "x": _coord,
    "y": _coord,
    "width": _box_dim,
    "height": _box_dim,
    "fill": _color,
    "stroke": _color,
    "label": _string(2000),
    "textColor": _color,
}
_CONNECTOR_FIELDS: dict[str, Callable[[Any], None]] = {
    "x1": _coord,
    "y1": _coord,
    "x2": _coord,
    "y2": _coord,
    "stroke": _color,
    "start": _binding,
    "end": _binding,
}

# Fields excluding the immutable `id` and `type`.
SHAPE_FIELDS: dict[str, dict[str, Callable[[Any], None]]] = {
    "rect": _BOX_FIELDS,
    "ellipse": _BOX_FIELDS,
    "text": {
        "x": _coord,
        "y": _coord,
        "width": _number(1, COORD_LIMIT),
        "text": _string(5000),
        "fontSize": _number(8, 200),
        "textColor": _color,
    },
    "line": _CONNECTOR_FIELDS,
    "arrow": _CONNECTOR_FIELDS,
}


def _validate_values(fields: dict[str, Callable[[Any], None]], values: dict[str, Any]) -> None:
    for name, value in values.items():
        try:
            fields[name](value)
        except _Invalid as e:
            raise _Invalid(f"{name} {e}") from None


def _validate_shape(shape: Any) -> Shape:
    if not isinstance(shape, dict):
        raise _Invalid("shape must be an object")
    shape_type = shape.get("type")
    if not isinstance(shape_type, str) or shape_type not in SHAPE_FIELDS:
        raise _Invalid("unknown shape type")
    fields = SHAPE_FIELDS[shape_type]
    missing = (set(fields) | {"id", "type"}) - set(shape)
    if missing:
        raise _Invalid(f"missing fields: {', '.join(sorted(missing))}")
    extra = set(shape) - set(fields) - {"id", "type"}
    if extra:
        raise _Invalid(f"unknown fields for {shape_type}: {', '.join(sorted(extra))}")
    if not isinstance(shape["id"], str) or not _ID_RE.fullmatch(shape["id"]):
        raise _Invalid("id must match ^[A-Za-z0-9_-]{1,64}$")
    _validate_values(fields, {k: v for k, v in shape.items() if k not in ("id", "type")})
    return shape


def _binding_error(shapes: dict[str, Shape], connector_id: str, binding: Binding | None) -> str | None:
    if binding is None:
        return None
    target_id = binding["shapeId"]
    target = shapes.get(target_id)
    if target_id == connector_id:
        return "a connector cannot be bound to itself"
    if target is None:
        return f"bound shape {target_id} does not exist"
    if target["type"] not in _BINDABLE_TYPES:
        return f"bound shape {target_id} must be a rect, ellipse or text"
    return None


def _check_bindings(shapes: dict[str, Shape], connector_id: str, values: dict[str, Any]) -> Rejection | None:
    for key in ("start", "end"):
        if key in values:
            error = _binding_error(shapes, connector_id, values[key])
            if error:
                return Rejection("invalid_binding", f"{key}: {error}")
    return None


def apply_op(shapes: dict[str, Shape], op: Any) -> AppliedOp | Rejection:
    """Validate `op` against `shapes` (id -> shape, insertion order = z-order) and apply it in place.

    On rejection `shapes` is left untouched. Check order follows the protocol:
    invalid_op -> duplicate_id / shape_not_found -> canvas_full -> invalid_binding.
    """
    if not isinstance(op, dict):
        return Rejection("invalid_op", "op must be an object")
    kind = op.get("kind")
    expected_keys = {
        "create": {"kind", "shape"},
        "update": {"kind", "id", "patch"},
        "delete": {"kind", "id"},
    }.get(kind) if isinstance(kind, str) else None
    if expected_keys is None:
        return Rejection("invalid_op", "unknown op kind")
    if set(op) != expected_keys:
        return Rejection("invalid_op", f"{kind} op must have exactly the keys: {', '.join(sorted(expected_keys))}")

    if kind == "create":
        return _apply_create(shapes, op["shape"])

    shape_id = op["id"]
    if not isinstance(shape_id, str):
        return Rejection("invalid_op", "id must be a string")
    if kind == "update":
        return _apply_update(shapes, shape_id, op["patch"])
    if shape_id not in shapes:
        return Rejection("shape_not_found", f"no shape with id {shape_id}")
    del shapes[shape_id]
    return AppliedOp(op={"kind": "delete", "id": shape_id}, shape=None)


def _apply_create(shapes: dict[str, Shape], raw_shape: Any) -> AppliedOp | Rejection:
    try:
        shape = _validate_shape(raw_shape)
    except _Invalid as e:
        return Rejection("invalid_op", str(e))
    if shape["id"] in shapes:
        return Rejection("duplicate_id", f"a shape with id {shape['id']} already exists")
    if len(shapes) >= MAX_SHAPES:
        return Rejection("canvas_full", f"the canvas already holds {MAX_SHAPES} shapes")
    rejection = _check_bindings(shapes, shape["id"], shape)
    if rejection:
        return rejection
    stored = dict(shape)
    shapes[stored["id"]] = stored
    return AppliedOp(op={"kind": "create", "shape": dict(stored)}, shape=stored)


def _apply_update(shapes: dict[str, Shape], shape_id: str, patch: Any) -> AppliedOp | Rejection:
    current = shapes.get(shape_id)
    if current is None:
        return Rejection("shape_not_found", f"no shape with id {shape_id}")
    if not isinstance(patch, dict):
        return Rejection("invalid_op", "patch must be an object")
    fields = SHAPE_FIELDS[current["type"]]
    unknown = set(patch) - set(fields)
    if unknown:
        return Rejection(
            "invalid_op",
            f"patch cannot contain {', '.join(sorted(unknown))} for a {current['type']}",
        )
    try:
        _validate_values(fields, patch)
    except _Invalid as e:
        return Rejection("invalid_op", str(e))
    rejection = _check_bindings(shapes, shape_id, patch)
    if rejection:
        return rejection
    merged = {**current, **patch}
    shapes[shape_id] = merged  # reassigning an existing key keeps its z-order position
    return AppliedOp(op={"kind": "update", "id": shape_id, "patch": dict(patch)}, shape=merged)
