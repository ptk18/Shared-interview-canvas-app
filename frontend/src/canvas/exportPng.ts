import type Konva from 'konva';
import { diagramBounds, type Rect, type Viewport } from './geometry';
import type { ShapeMap } from './ops';

const EXPORT_PADDING = 32;
/** Target resolution: 2 output pixels per world unit, like a retina screenshot at 100%. */
const TARGET_DENSITY = 2;
/** Keep the longest side within what every browser can allocate for a canvas. */
const MAX_OUTPUT_SIDE = 8192;

export interface ExportRegion {
  /** Region in stage-container pixels, the coordinate space Konva's toCanvas expects. */
  x: number;
  y: number;
  width: number;
  height: number;
  pixelRatio: number;
  outputWidth: number;
  outputHeight: number;
}

/**
 * Where to capture the entire diagram — not just the visible viewport — and at
 * what pixel ratio, independent of the current zoom.
 */
export function exportRegion(bounds: Rect, viewport: Viewport): ExportRegion {
  const world = {
    x: bounds.x - EXPORT_PADDING,
    y: bounds.y - EXPORT_PADDING,
    width: bounds.width + EXPORT_PADDING * 2,
    height: bounds.height + EXPORT_PADDING * 2,
  };
  const density = Math.min(TARGET_DENSITY, MAX_OUTPUT_SIDE / Math.max(world.width, world.height));
  const width = world.width * viewport.scale;
  const height = world.height * viewport.scale;
  const pixelRatio = density / viewport.scale;
  return {
    x: world.x * viewport.scale + viewport.x,
    y: world.y * viewport.scale + viewport.y,
    width,
    height,
    pixelRatio,
    outputWidth: Math.round(width * pixelRatio),
    outputHeight: Math.round(height * pixelRatio),
  };
}

export function exportFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'diagram'}.png`;
}

/**
 * Renders every shape on `layer` to a PNG on a white background and downloads it.
 * Returns false when there is nothing to export.
 */
export async function exportDiagramPng(
  layer: Konva.Layer,
  shapes: ShapeMap,
  viewport: Viewport,
  title: string,
): Promise<boolean> {
  const bounds = diagramBounds(shapes);
  if (!bounds) return false;
  const region = exportRegion(bounds, viewport);
  // Konva re-draws the layer into a fresh canvas, so shapes outside the
  // visible viewport are included.
  const drawing = layer.toCanvas({
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
    pixelRatio: region.pixelRatio,
  });
  const out = document.createElement('canvas');
  out.width = drawing.width;
  out.height = drawing.height;
  const ctx = out.getContext('2d');
  if (!ctx) return false;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(drawing, 0, 0);

  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
  if (!blob) return false;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = exportFileName(title);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
