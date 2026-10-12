import { describe, expect, it } from 'vitest';
import type { BoxShape, ConnectorShape, TextShape } from '../services/protocol';
import { diagramBounds, fitViewport, hitTestBindable, outlinePoint, resolveConnector, screenToWorld, worldToScreen, zoomAt } from './geometry';
import { toShapeMap } from './ops';

const box = (id: string, x: number, y: number, w = 100, h = 50, type: 'rect' | 'ellipse' = 'rect'): BoxShape => ({
  id, type, x, y, width: w, height: h, fill: '#ffffff', stroke: '#000000', label: '', textColor: '#000000',
});
const conn = (over: Partial<ConnectorShape> = {}): ConnectorShape => ({
  id: 'c', type: 'arrow', x1: 0, y1: 0, x2: 10, y2: 0, stroke: '#000000', start: null, end: null, ...over,
});

describe('outlinePoint', () => {
  it('leaves a rectangle through the side facing the target, just outside the outline', () => {
    const p = outlinePoint(box('a', 0, 0, 100, 50), { x: 500, y: 25 });
    expect(p.y).toBeCloseTo(25);
    expect(p.x).toBeGreaterThan(100);
    expect(p.x).toBeLessThan(105);
  });

  it('follows the curve of an ellipse rather than its bounding box', () => {
    const e = box('e', 0, 0, 100, 100, 'ellipse');
    const diagonal = outlinePoint(e, { x: 1000, y: 1000 });
    const r = Math.hypot(diagonal.x - 50, diagonal.y - 50);
    expect(r).toBeGreaterThan(50);
    expect(r).toBeLessThan(55); // a box corner would be ~70.7 from the centre
  });

  it('attaches at the centre when the target point lies inside the shape', () => {
    expect(outlinePoint(box('a', 0, 0, 100, 50), { x: 60, y: 30 })).toEqual({ x: 50, y: 25 });
  });
});

describe('resolveConnector', () => {
  it('uses the stored points when unbound', () => {
    expect(resolveConnector(conn({ x1: 1, y1: 2, x2: 3, y2: 4 }), new Map())).toEqual({ x1: 1, y1: 2, x2: 3, y2: 4 });
  });

  it('follows bound shapes when they move', () => {
    const c = conn({ start: { shapeId: 'a' }, end: { shapeId: 'b' } });
    const before = resolveConnector(c, toShapeMap([box('a', 0, 0), box('b', 300, 0), c]));
    const after = resolveConnector(c, toShapeMap([box('a', 0, 200), box('b', 300, 0), c]));
    expect(before.y1).toBeCloseTo(25);
    // The box now sits below its target, so the arrow leaves through its top edge, just outside.
    expect(after.y1).toBeGreaterThan(190);
    expect(after.y1).toBeLessThan(200);
    // ...and enters the target box (y 0–50) through its bottom edge.
    expect(after.y2).toBeGreaterThan(50);
    expect(after.y2).toBeLessThan(55);
  });

  it('falls back to stored coordinates when a bound shape no longer exists', () => {
    const c = conn({ x1: 7, y1: 8, start: { shapeId: 'gone' } });
    expect(resolveConnector(c, toShapeMap([c]))).toMatchObject({ x1: 7, y1: 8 });
  });

  it('ignores bindings to other connectors', () => {
    const other = conn({ id: 'other' });
    const c = conn({ x1: 5, y1: 5, start: { shapeId: 'other' } });
    expect(resolveConnector(c, toShapeMap([other, c]))).toMatchObject({ x1: 5, y1: 5 });
  });
});

describe('hit testing and bounds', () => {
  it('returns the topmost bindable shape under the point and skips connectors', () => {
    const shapes = toShapeMap([box('bottom', 0, 0, 200, 200), box('top', 50, 50), conn({ x1: 0, y1: 0, x2: 300, y2: 300 })]);
    expect(hitTestBindable({ x: 60, y: 60 }, shapes)?.id).toBe('top');
    expect(hitTestBindable({ x: 10, y: 10 }, shapes)?.id).toBe('bottom');
    expect(hitTestBindable({ x: 60, y: 60 }, shapes, 'top')?.id).toBe('bottom');
    expect(hitTestBindable({ x: 900, y: 900 }, shapes)).toBeUndefined();
  });

  it('covers every shape — including ones far outside any viewport — in the diagram bounds', () => {
    const text: TextShape = { id: 't', type: 'text', x: -5000, y: 0, width: 100, text: 'far away', fontSize: 20, textColor: '#000000' };
    const b = diagramBounds(toShapeMap([box('a', 0, 0), box('b', 4000, 3000), text]))!;
    expect(b.x).toBeLessThanOrEqual(-5000);
    expect(b.x + b.width).toBeGreaterThanOrEqual(4100);
    expect(b.y + b.height).toBeGreaterThanOrEqual(3050);
    expect(diagramBounds(new Map())).toBeNull();
  });
});

describe('viewport math', () => {
  it('round-trips screen and world coordinates', () => {
    const vp = { x: 120, y: -40, scale: 2.5 };
    const p = { x: 33, y: 77 };
    const back = worldToScreen(screenToWorld(p, vp), vp);
    expect(back.x).toBeCloseTo(p.x);
    expect(back.y).toBeCloseTo(p.y);
  });

  it('zooms around the anchor point and clamps the scale', () => {
    const vp = { x: 0, y: 0, scale: 1 };
    const anchor = { x: 200, y: 100 };
    const zoomed = zoomAt(vp, anchor, 2);
    expect(screenToWorld(anchor, zoomed)).toEqual(screenToWorld(anchor, vp));
    expect(zoomAt(vp, anchor, 1000).scale).toBe(4);
    expect(zoomAt(vp, anchor, 0.0001).scale).toBe(0.1);
  });

  it('fits a large diagram on screen without zooming small ones past 100%', () => {
    const size = { width: 1000, height: 800 };
    expect(fitViewport({ x: 0, y: 0, width: 100, height: 100 }, size).scale).toBe(1);
    const big = fitViewport({ x: 0, y: 0, width: 4000, height: 1000 }, size);
    expect(big.scale).toBeCloseTo((1000 - 96) / 4000);
    expect(fitViewport(null, size)).toEqual({ x: 500, y: 400, scale: 1 });
  });
});
