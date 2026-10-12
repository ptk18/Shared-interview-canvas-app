import type { Op, Shape } from '../services/protocol';

/** Shapes keyed by id. Map iteration order is the z-order (first = bottom). */
export type ShapeMap = ReadonlyMap<string, Shape>;

export function toShapeMap(shapes: readonly Shape[]): Map<string, Shape> {
  return new Map(shapes.map((s) => [s.id, s]));
}

/**
 * Applies an op without validating it. Used for ops the server already accepted
 * and for replaying optimistic local ops; an op that no longer fits (e.g. an
 * update to a shape someone else deleted) is a no-op rather than an error.
 */
export function applyOp(shapes: ShapeMap, op: Op): Map<string, Shape> {
  const next = new Map(shapes);
  switch (op.kind) {
    case 'create':
      if (!next.has(op.shape.id)) next.set(op.shape.id, op.shape);
      break;
    case 'update': {
      const current = next.get(op.id);
      // Map.set on an existing key keeps its position, so updates preserve z-order.
      if (current) next.set(op.id, { ...current, ...op.patch } as Shape);
      break;
    }
    case 'delete':
      next.delete(op.id);
      break;
  }
  return next;
}
