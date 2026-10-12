import type { ConnectorShape, Point, Shape, TextShape } from '../services/protocol';
import type { ShapeMap } from './ops';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Viewport {
  /** Screen position of the world origin. */
  x: number;
  y: number;
  scale: number;
}

export const TEXT_LINE_HEIGHT = 1.25;
const AVG_CHAR_WIDTH_EM = 0.55;
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 4;
/** Gap between a bound connector endpoint and the shape outline, in world units. */
const ATTACH_GAP = 3;

export function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/**
 * Estimated rendered height of a text shape. Konva measures text precisely when
 * drawing; this estimate only feeds hit-testing, connector attachment and export
 * bounds, where being a few pixels off is harmless.
 */
export function estimateTextHeight(shape: Pick<TextShape, 'text' | 'width' | 'fontSize'>): number {
  const charsPerLine = Math.max(1, Math.floor(shape.width / (shape.fontSize * AVG_CHAR_WIDTH_EM)));
  const lines = shape.text
    .split('\n')
    .reduce((sum, paragraph) => sum + Math.max(1, Math.ceil(paragraph.length / charsPerLine)), 0);
  return lines * shape.fontSize * TEXT_LINE_HEIGHT;
}

export function isBindable(shape: Shape | undefined): shape is Exclude<Shape, ConnectorShape> {
  return !!shape && (shape.type === 'rect' || shape.type === 'ellipse' || shape.type === 'text');
}

export function isConnector(shape: Shape | undefined): shape is ConnectorShape {
  return !!shape && (shape.type === 'line' || shape.type === 'arrow');
}

/** Box of a rect, ellipse or text shape. */
export function boxOf(shape: Exclude<Shape, ConnectorShape>): Rect {
  if (shape.type === 'text') {
    return { x: shape.x, y: shape.y, width: shape.width, height: estimateTextHeight(shape) };
  }
  return { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
}

function center(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/**
 * Where a ray from the centre of `shape` towards `toward` leaves the shape's
 * outline (an ellipse for ellipses, the box otherwise), pulled out by a small gap.
 */
export function outlinePoint(shape: Exclude<Shape, ConnectorShape>, toward: Point): Point {
  const box = boxOf(shape);
  const c = center(box);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  const hw = box.width / 2;
  const hh = box.height / 2;
  if ((dx === 0 && dy === 0) || hw === 0 || hh === 0) return c;

  let t: number;
  if (shape.type === 'ellipse') {
    t = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
  } else {
    t = Math.min(dx === 0 ? Infinity : hw / Math.abs(dx), dy === 0 ? Infinity : hh / Math.abs(dy));
  }
  // `toward` lies inside the shape (overlapping shapes): attach at the centre.
  if (t >= 1) return c;
  const len = Math.hypot(dx, dy);
  const gap = Math.min(ATTACH_GAP / len, 1 - t);
  return { x: c.x + dx * (t + gap), y: c.y + dy * (t + gap) };
}

function boundTarget(binding: ConnectorShape['start'], self: ConnectorShape, shapes: ShapeMap) {
  if (!binding || binding.shapeId === self.id) return undefined;
  const target = shapes.get(binding.shapeId);
  return isBindable(target) ? target : undefined;
}

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * The endpoints a connector is drawn with. A bound endpoint sits on the outline
 * of its shape, aimed at the other end, so it follows the shape as it moves or
 * resizes. An unbound endpoint (or one whose shape was deleted) uses the stored
 * fallback coordinates.
 */
export function resolveConnector(conn: ConnectorShape, shapes: ShapeMap): Segment {
  const startShape = boundTarget(conn.start, conn, shapes);
  const endShape = boundTarget(conn.end, conn, shapes);
  const startRef = startShape ? center(boxOf(startShape)) : { x: conn.x1, y: conn.y1 };
  const endRef = endShape ? center(boxOf(endShape)) : { x: conn.x2, y: conn.y2 };
  const a = startShape ? outlinePoint(startShape, endRef) : startRef;
  const b = endShape ? outlinePoint(endShape, startRef) : endRef;
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}

/** World-space bounds of one shape, including room for stroke and arrowheads. */
export function shapeBounds(shape: Shape, shapes: ShapeMap): Rect {
  if (isConnector(shape)) {
    const s = resolveConnector(shape, shapes);
    const pad = shape.type === 'arrow' ? 12 : 3;
    const r = normalizeRect({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 });
    return { x: r.x - pad, y: r.y - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
  }
  const box = boxOf(shape);
  const pad = 2; // half the 2px stroke, plus antialiasing
  return { x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 };
}

/** Bounds of the whole diagram (used for full-diagram export), or null when empty. */
export function diagramBounds(shapes: ShapeMap): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const shape of shapes.values()) {
    const b = shapeBounds(shape, shapes);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Topmost rect/ellipse/text under `point`, ignoring `excludeId`. */
export function hitTestBindable(point: Point, shapes: ShapeMap, excludeId?: string): Shape | undefined {
  const ordered = [...shapes.values()].reverse();
  return ordered.find((shape) => {
    if (shape.id === excludeId || !isBindable(shape)) return false;
    const b = boxOf(shape);
    const margin = 4;
    return (
      point.x >= b.x - margin &&
      point.x <= b.x + b.width + margin &&
      point.y >= b.y - margin &&
      point.y <= b.y + b.height + margin
    );
  });
}

export function screenToWorld(point: Point, vp: Viewport): Point {
  return { x: (point.x - vp.x) / vp.scale, y: (point.y - vp.y) / vp.scale };
}

export function worldToScreen(point: Point, vp: Viewport): Point {
  return { x: point.x * vp.scale + vp.x, y: point.y * vp.scale + vp.y };
}

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Zooms by `factor` keeping the world point under `anchor` (screen coords) fixed. */
export function zoomAt(vp: Viewport, anchor: Point, factor: number): Viewport {
  const scale = clampScale(vp.scale * factor);
  const world = screenToWorld(anchor, vp);
  return { scale, x: anchor.x - world.x * scale, y: anchor.y - world.y * scale };
}

/** Viewport that fits `bounds` inside a screen of `size`, never zooming in past 100%. */
export function fitViewport(bounds: Rect | null, size: { width: number; height: number }, padding = 48): Viewport {
  if (!bounds || size.width <= 0 || size.height <= 0) return { x: size.width / 2, y: size.height / 2, scale: 1 };
  const availW = Math.max(1, size.width - padding * 2);
  const availH = Math.max(1, size.height - padding * 2);
  const scale = clampScale(Math.min(1, availW / Math.max(bounds.width, 1), availH / Math.max(bounds.height, 1)));
  const c = center(bounds);
  return { scale, x: size.width / 2 - c.x * scale, y: size.height / 2 - c.y * scale };
}
