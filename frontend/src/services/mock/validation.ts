// Server-side op validation for the mock backend. Mirrors the FastAPI backend;
// both run shared/op-validation-cases.json so they cannot drift apart.
import type { Op, OpRejectionCode, Shape, ShapeType } from '../protocol';
import { MAX_SHAPES } from '../protocol';

export type ValidationResult =
  | { ok: true; op: Op }
  | { ok: false; code: Exclude<OpRejectionCode, 'room_completed'>; message: string };

type Check = (value: unknown) => boolean;

const COORD_LIMIT = 1_000_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

const isNumberIn = (min: number, max: number): Check => (v) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
/** Lengths are Unicode code points, like Python's len(); `.length` would count UTF-16 units. */
export const codePointLength = (s: string) => [...s].length;
const isStringUpTo = (max: number): Check => (v) => typeof v === 'string' && codePointLength(v) <= max;

const coord = isNumberIn(-COORD_LIMIT, COORD_LIMIT);
const size = isNumberIn(0, COORD_LIMIT);
const color: Check = (v) => v === 'transparent' || (typeof v === 'string' && COLOR_PATTERN.test(v));
const binding: Check = (v) =>
  v === null ||
  (isPlainObject(v) && Object.keys(v).length === 1 && typeof v.shapeId === 'string' && ID_PATTERN.test(v.shapeId));

const BOX_FIELDS: Record<string, Check> = {
  x: coord,
  y: coord,
  width: size,
  height: size,
  fill: color,
  stroke: color,
  label: isStringUpTo(2000),
  textColor: color,
};

const FIELDS: Record<ShapeType, Record<string, Check>> = {
  rect: BOX_FIELDS,
  ellipse: BOX_FIELDS,
  text: {
    x: coord,
    y: coord,
    width: isNumberIn(1, COORD_LIMIT),
    text: isStringUpTo(5000),
    fontSize: isNumberIn(8, 200),
    textColor: color,
  },
  line: { x1: coord, y1: coord, x2: coord, y2: coord, stroke: color, start: binding, end: binding },
  arrow: { x1: coord, y1: coord, x2: coord, y2: coord, stroke: color, start: binding, end: binding },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasExactKeys(obj: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(obj);
  return actual.length === keys.length && keys.every((k) => Object.hasOwn(obj, k));
}

function isShapeType(v: unknown): v is ShapeType {
  return typeof v === 'string' && Object.hasOwn(FIELDS, v);
}

/** Field-level validity of a complete shape (binding targets are checked separately). */
function isValidShape(shape: unknown): shape is Shape {
  if (!isPlainObject(shape) || !isShapeType(shape.type)) return false;
  const fields = FIELDS[shape.type];
  if (!hasExactKeys(shape, ['id', 'type', ...Object.keys(fields)])) return false;
  if (typeof shape.id !== 'string' || !ID_PATTERN.test(shape.id)) return false;
  return Object.entries(fields).every(([key, check]) => check(shape[key]));
}

function bindingError(
  value: unknown,
  selfId: string,
  shapes: ReadonlyMap<string, Shape>,
): string | null {
  if (value === null) return null;
  const targetId = (value as { shapeId: string }).shapeId;
  const target = shapes.get(targetId);
  if (targetId === selfId) return 'A connector cannot attach to itself.';
  if (!target) return `Shape ${targetId} does not exist.`;
  if (target.type === 'line' || target.type === 'arrow') return 'Connectors can only attach to boxes, ellipses and text.';
  return null;
}

const reject = (code: Exclude<OpRejectionCode, 'room_completed'>, message: string): ValidationResult => ({
  ok: false,
  code,
  message,
});

/** Validates an untrusted op against the current canvas and returns it normalized. */
export function validateOp(shapes: ReadonlyMap<string, Shape>, raw: unknown): ValidationResult {
  if (!isPlainObject(raw)) return reject('invalid_op', 'Op must be an object.');

  switch (raw.kind) {
    case 'create': {
      if (!hasExactKeys(raw, ['kind', 'shape'])) return reject('invalid_op', 'Malformed create op.');
      if (!isValidShape(raw.shape)) return reject('invalid_op', 'Invalid shape.');
      const shape = raw.shape;
      if (shapes.has(shape.id)) return reject('duplicate_id', `Shape ${shape.id} already exists.`);
      if (shapes.size >= MAX_SHAPES) return reject('canvas_full', `A canvas holds at most ${MAX_SHAPES} shapes.`);
      if (shape.type === 'line' || shape.type === 'arrow') {
        const error = bindingError(shape.start, shape.id, shapes) ?? bindingError(shape.end, shape.id, shapes);
        if (error) return reject('invalid_binding', error);
      }
      return { ok: true, op: { kind: 'create', shape: structuredClone(shape) } };
    }

    case 'update': {
      if (!hasExactKeys(raw, ['kind', 'id', 'patch']) || typeof raw.id !== 'string') {
        return reject('invalid_op', 'Malformed update op.');
      }
      const current = shapes.get(raw.id);
      if (!current) return reject('shape_not_found', `Shape ${raw.id} does not exist.`);
      const patch = raw.patch;
      if (!isPlainObject(patch)) return reject('invalid_op', 'Patch must be an object.');
      const allowed = FIELDS[current.type];
      if (!Object.keys(patch).every((key) => Object.hasOwn(allowed, key))) {
        return reject('invalid_op', `Patch has fields a ${current.type} does not have.`);
      }
      if (!isValidShape({ ...current, ...patch })) return reject('invalid_op', 'Patch makes the shape invalid.');
      for (const key of ['start', 'end'] as const) {
        if (!Object.hasOwn(patch, key)) continue;
        const error = bindingError(patch[key], current.id, shapes);
        if (error) return reject('invalid_binding', error);
      }
      return { ok: true, op: { kind: 'update', id: raw.id, patch: structuredClone(patch) } };
    }

    case 'delete': {
      if (!hasExactKeys(raw, ['kind', 'id']) || typeof raw.id !== 'string') {
        return reject('invalid_op', 'Malformed delete op.');
      }
      if (!shapes.has(raw.id)) return reject('shape_not_found', `Shape ${raw.id} does not exist.`);
      return { ok: true, op: { kind: 'delete', id: raw.id } };
    }

    default:
      return reject('invalid_op', 'Unknown op kind.');
  }
}
