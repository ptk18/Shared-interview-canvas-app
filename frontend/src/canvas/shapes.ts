import type { BoxShape, ConnectorShape, Op, Point, Shape, ShapePatch, TextShape } from '../services/protocol';
import { isConnector, normalizeRect, resolveConnector } from './geometry';
import type { ShapeMap } from './ops';

export type DrawTool = 'rect' | 'ellipse' | 'line' | 'arrow' | 'text';
export type Tool = 'select' | 'pan' | DrawTool;

export interface Style {
  fill: string;
  stroke: string;
  textColor: string;
}

export type StyleKey = keyof Style;

export const INK = '#1f2328';
export const DEFAULT_STYLE: Style = { fill: '#ffffff', stroke: INK, textColor: INK };
export const DEFAULT_FONT_SIZE = 18;
export const DEFAULT_TEXT_WIDTH = 220;
/** A drag shorter than this (world units) counts as a click and gets a default size. */
const CLICK_THRESHOLD = 6;
const DEFAULT_BOX = { rect: { width: 160, height: 80 }, ellipse: { width: 140, height: 90 } };

export function newShapeId(): string {
  return crypto.randomUUID();
}

export function createBox(type: 'rect' | 'ellipse', from: Point, to: Point, style: Style, id = newShapeId()): BoxShape {
  let r = normalizeRect(from, to);
  if (r.width < CLICK_THRESHOLD && r.height < CLICK_THRESHOLD) {
    const size = DEFAULT_BOX[type];
    r = { x: from.x - size.width / 2, y: from.y - size.height / 2, ...size };
  }
  return {
    id,
    type,
    x: round(r.x),
    y: round(r.y),
    width: round(r.width),
    height: round(r.height),
    fill: style.fill,
    stroke: style.stroke,
    label: '',
    textColor: style.textColor,
  };
}

export function createText(at: Point, text: string, style: Style, id = newShapeId()): TextShape {
  return {
    id,
    type: 'text',
    x: round(at.x),
    y: round(at.y),
    width: DEFAULT_TEXT_WIDTH,
    text,
    fontSize: DEFAULT_FONT_SIZE,
    textColor: style.textColor,
  };
}

export function createConnector(
  type: 'line' | 'arrow',
  from: Point,
  to: Point,
  bindings: { start?: string | null; end?: string | null },
  style: Style,
  shapes: ShapeMap,
  id = newShapeId(),
): ConnectorShape | null {
  const conn: ConnectorShape = {
    id,
    type,
    x1: round(from.x),
    y1: round(from.y),
    x2: round(to.x),
    y2: round(to.y),
    stroke: style.stroke,
    start: bindings.start ? { shapeId: bindings.start } : null,
    end: bindings.end && bindings.end !== bindings.start ? { shapeId: bindings.end } : null,
  };
  // Store the rendered geometry as the fallback, so the connector stays put if
  // its shapes are deleted later.
  const seg = resolveConnector(conn, shapes);
  const resolved = { ...conn, x1: round(seg.x1), y1: round(seg.y1), x2: round(seg.x2), y2: round(seg.y2) };
  const length = Math.hypot(resolved.x2 - resolved.x1, resolved.y2 - resolved.y1);
  // A click without a drag between two unbound points is not a line.
  if (length < CLICK_THRESHOLD && !(resolved.start && resolved.end)) return null;
  return resolved;
}

/** Which colour controls apply to a shape type. */
export function styleKeysFor(shape: Shape): StyleKey[] {
  switch (shape.type) {
    case 'rect':
    case 'ellipse':
      return ['fill', 'stroke', 'textColor'];
    case 'text':
      return ['textColor'];
    case 'line':
    case 'arrow':
      return ['stroke'];
  }
}

export function stylePatch(shape: Shape, key: StyleKey, color: string): ShapePatch | null {
  return styleKeysFor(shape).includes(key) ? ({ [key]: color } as ShapePatch) : null;
}

/**
 * Ops that delete a shape. Connectors attached to it are first detached at
 * their current rendered position, so they don't jump when the shape goes away.
 */
export function deleteOps(shapeId: string, shapes: ShapeMap): Op[] {
  const ops: Op[] = [];
  for (const shape of shapes.values()) {
    if (!isConnector(shape) || shape.id === shapeId) continue;
    const startBound = shape.start?.shapeId === shapeId;
    const endBound = shape.end?.shapeId === shapeId;
    if (!startBound && !endBound) continue;
    const seg = resolveConnector(shape, shapes);
    const patch: Partial<ConnectorShape> = {};
    if (startBound) Object.assign(patch, { start: null, x1: round(seg.x1), y1: round(seg.y1) });
    if (endBound) Object.assign(patch, { end: null, x2: round(seg.x2), y2: round(seg.y2) });
    ops.push({ kind: 'update', id: shape.id, patch });
  }
  ops.push({ kind: 'delete', id: shapeId });
  return ops;
}

export function round(n: number): number {
  return Math.round(n * 100) / 100;
}
