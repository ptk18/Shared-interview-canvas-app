import { describe, expect, it } from 'vitest';
import fixture from '../../../../shared/op-validation-cases.json';
import { applyOp, toShapeMap } from '../../canvas/ops';
import type { BoxShape, Shape } from '../protocol';
import { MAX_SHAPES } from '../protocol';
import { validateOp } from './validation';

interface Case {
  name: string;
  op: unknown;
  expect: 'accepted' | { rejected: string };
  expectShape?: Shape;
}

const base = fixture.baseCanvas.shapes as Shape[];

describe('validateOp — shared fixture (parity with the FastAPI backend)', () => {
  it.each((fixture.cases as Case[]).map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const shapes = toShapeMap(structuredClone(base));
    const result = validateOp(shapes, c.op);
    if (c.expect === 'accepted') {
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      if (c.expectShape) {
        const next = applyOp(shapes, result.op);
        expect(next.get(c.expectShape.id)).toEqual(c.expectShape);
      }
    } else {
      expect(result).toMatchObject({ ok: false, code: c.expect.rejected });
    }
  });
});

describe('validateOp — beyond the fixture', () => {
  it('rejects creates once the canvas holds the maximum number of shapes', () => {
    const shapes = new Map<string, Shape>();
    for (let i = 0; i < MAX_SHAPES; i++) shapes.set(`s${i}`, { ...base[0]!, id: `s${i}` } as Shape);
    expect(validateOp(shapes, { kind: 'create', shape: { ...base[0]!, id: 'one-more' } })).toMatchObject({
      ok: false,
      code: 'canvas_full',
    });
  });

  it('returns a copy so later mutation of the input cannot alter the accepted op', () => {
    const shape = { ...(base[0] as BoxShape), id: 'fresh' };
    const result = validateOp(toShapeMap(base), { kind: 'create', shape });
    shape.x = 999;
    expect(result.ok && result.op.kind === 'create' && (result.op.shape as BoxShape).x).toBe(0);
  });
});
