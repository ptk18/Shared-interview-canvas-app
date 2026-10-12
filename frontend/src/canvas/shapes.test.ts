import { describe, expect, it } from 'vitest';
import type { BoxShape, ConnectorShape } from '../services/protocol';
import { validateOp } from '../services/mock/validation';
import { exportFileName, exportRegion } from './exportPng';
import { applyOp, toShapeMap } from './ops';
import { createBox, createConnector, createText, DEFAULT_STYLE, deleteOps, styleKeysFor, stylePatch } from './shapes';

const style = { fill: '#fff3bf', stroke: '#1971c2', textColor: '#e03131' };

describe('shape factories', () => {
  it('normalizes a box dragged up and to the left', () => {
    expect(createBox('rect', { x: 100, y: 80 }, { x: 20, y: 10 }, style, 'r')).toMatchObject({
      x: 20, y: 10, width: 80, height: 70, fill: '#fff3bf', stroke: '#1971c2', textColor: '#e03131', label: '',
    });
  });

  it('gives a plain click a default-sized box centred on the pointer', () => {
    const r = createBox('ellipse', { x: 100, y: 100 }, { x: 102, y: 101 }, style, 'e');
    expect(r).toMatchObject({ width: 140, height: 90, x: 30, y: 55 });
  });

  it('binds a connector to the shapes it was drawn between and stores its rendered endpoints', () => {
    const shapes = toShapeMap([createBox('rect', { x: 0, y: 0 }, { x: 100, y: 50 }, style, 'a'), createBox('rect', { x: 300, y: 0 }, { x: 400, y: 50 }, style, 'b')]);
    const c = createConnector('arrow', { x: 50, y: 25 }, { x: 350, y: 25 }, { start: 'a', end: 'b' }, style, shapes, 'c')!;
    expect(c).toMatchObject({ start: { shapeId: 'a' }, end: { shapeId: 'b' }, stroke: '#1971c2' });
    expect(c.x1).toBeGreaterThan(100);
    expect(c.x2).toBeLessThan(300);
  });

  it('does not create a connector from a click with no drag', () => {
    expect(createConnector('line', { x: 5, y: 5 }, { x: 6, y: 6 }, {}, style, new Map())).toBeNull();
  });

  it('never binds both ends of a connector to the same shape', () => {
    const shapes = toShapeMap([createBox('rect', { x: 0, y: 0 }, { x: 100, y: 50 }, style, 'a')]);
    const c = createConnector('line', { x: 10, y: 10 }, { x: 300, y: 300 }, { start: 'a', end: 'a' }, style, shapes)!;
    expect(c.end).toBeNull();
  });

  it('produces shapes the server accepts', () => {
    const shapes = new Map();
    for (const shape of [
      createBox('rect', { x: 0.123, y: 0 }, { x: 10, y: 10 }, DEFAULT_STYLE),
      createText({ x: 1, y: 2 }, 'hello', DEFAULT_STYLE),
    ]) {
      expect(validateOp(shapes, { kind: 'create', shape })).toMatchObject({ ok: true });
    }
  });
});

describe('styling', () => {
  it('only offers colours that apply to the shape type', () => {
    const conn = { type: 'arrow' } as ConnectorShape;
    expect(styleKeysFor(conn)).toEqual(['stroke']);
    expect(stylePatch(conn, 'fill', '#ffffff')).toBeNull();
    expect(stylePatch({ type: 'rect' } as BoxShape, 'fill', '#ffffff')).toEqual({ fill: '#ffffff' });
  });
});

describe('deleteOps', () => {
  it('detaches connectors at their current position before deleting the shape', () => {
    const a = createBox('rect', { x: 0, y: 0 }, { x: 100, y: 50 }, style, 'a');
    const b = createBox('rect', { x: 300, y: 0 }, { x: 400, y: 50 }, style, 'b');
    const shapes = toShapeMap([a, b]);
    const c = createConnector('arrow', { x: 50, y: 25 }, { x: 350, y: 25 }, { start: 'a', end: 'b' }, style, shapes, 'c')!;
    const all = toShapeMap([a, b, c]);
    const ops = deleteOps('b', all);
    expect(ops.map((o) => o.kind)).toEqual(['update', 'delete']);
    let after = all;
    for (const op of ops) after = applyOp(after, op);
    const detached = after.get('c') as ConnectorShape;
    expect(detached.end).toBeNull();
    expect(detached.start).toEqual({ shapeId: 'a' });
    expect(detached.x2).toBeCloseTo(c.x2);
    expect(after.has('b')).toBe(false);
  });
});

describe('applyOp', () => {
  it('keeps z-order on update and tolerates ops that no longer apply', () => {
    const shapes = toShapeMap([createBox('rect', { x: 0, y: 0 }, { x: 10, y: 10 }, style, 'a'), createBox('rect', { x: 0, y: 0 }, { x: 10, y: 10 }, style, 'b')]);
    const updated = applyOp(shapes, { kind: 'update', id: 'a', patch: { x: 99 } });
    expect([...updated.keys()]).toEqual(['a', 'b']);
    expect(applyOp(shapes, { kind: 'update', id: 'ghost', patch: { x: 1 } })).toEqual(shapes);
    expect(shapes.get('a')).toMatchObject({ x: 0 }); // input untouched
  });
});

describe('export', () => {
  it('captures the whole diagram regardless of the current pan and zoom', () => {
    const bounds = { x: -100, y: 50, width: 400, height: 200 };
    const a = exportRegion(bounds, { x: 0, y: 0, scale: 1 });
    const b = exportRegion(bounds, { x: 333, y: -120, scale: 0.25 });
    expect([a.outputWidth, a.outputHeight]).toEqual([928, 528]); // (400+64)×2, (200+64)×2
    expect([b.outputWidth, b.outputHeight]).toEqual([928, 528]);
    expect(b.x).toBeCloseTo((-100 - 32) * 0.25 + 333);
  });

  it('caps the output size for huge diagrams', () => {
    const r = exportRegion({ x: 0, y: 0, width: 50_000, height: 1_000 }, { x: 0, y: 0, scale: 1 });
    expect(r.outputWidth).toBeLessThanOrEqual(8192);
  });

  it('derives a safe file name from the title', () => {
    expect(exportFileName('Design a URL Shortener!')).toBe('design-a-url-shortener.png');
    expect(exportFileName('???')).toBe('diagram.png');
  });
});
