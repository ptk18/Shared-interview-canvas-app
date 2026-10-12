import type Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { Arrow, Circle, Group, Label, Layer, Line, Path, Rect, Shape as KShape, Stage, Tag, Text, Transformer } from 'react-konva';
import {
  boxOf,
  hitTestBindable,
  isBindable,
  isConnector,
  normalizeRect,
  resolveConnector,
  screenToWorld,
  TEXT_LINE_HEIGHT,
  type Viewport,
  worldToScreen,
  zoomAt,
} from '../canvas/geometry';
import type { ShapeMap } from '../canvas/ops';
import {
  createBox,
  createConnector,
  createText,
  DEFAULT_FONT_SIZE,
  DEFAULT_TEXT_WIDTH,
  deleteOps,
  type DrawTool,
  round,
  type Style,
  type Tool,
} from '../canvas/shapes';
import type { RemoteCursor } from '../room/roomSession';
import { throttle } from '../room/throttle';
import type { BoxShape, ConnectorShape, Op, Point, Shape, ShapePatch, TextShape } from '../services/protocol';

export const FONT_FAMILY = 'IBM Plex Sans, ui-sans-serif, system-ui, sans-serif';
const LABEL_FONT_SIZE = 16;
const LABEL_PADDING = 8;
// Not a participant colour, so your own selection never looks like your partner's cursor.
const SELECTION = '#6741d9';
/** Drag/resize updates are sent at most this often; the final position is always sent on release. */
const DRAG_SEND_MS = 50;
const GRID = 24;

type Editing = { kind: 'existing'; id: string } | { kind: 'new'; at: Point };

interface Drawing {
  tool: DrawTool;
  from: Point;
  to: Point;
  /** Shape the connector starts on, if any. */
  start: string | null;
}

export interface WhiteboardProps {
  shapes: ShapeMap;
  tool: Tool;
  /** Edits are possible right now (connected, session active). */
  editable: boolean;
  /** Review mode: pan and zoom only. */
  readOnly: boolean;
  style: Style;
  selectedId: string | null;
  viewport: Viewport;
  cursors: RemoteCursor[];
  shapesLayerRef: RefObject<Konva.Layer | null>;
  onResize(size: { width: number; height: number }): void;
  onSelect(id: string | null): void;
  onToolChange(tool: Tool): void;
  onViewportChange(viewport: Viewport): void;
  onOps(ops: Op[]): void;
  onCursor(position: Point | null): void;
}

export function Whiteboard(props: WhiteboardProps) {
  const { shapes, tool, editable, readOnly, style, selectedId, viewport, cursors } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [drafts, setDrafts] = useState<Record<string, ShapePatch>>({});
  const [drawing, setDrawing] = useState<Drawing | null>(null);
  const drawingRef = useRef<Drawing | null>(null);
  const [hoverTarget, setHoverTarget] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [handleEpoch, setHandleEpoch] = useState(0);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  // Latest props for callbacks created once.
  const latest = useRef(props);
  latest.current = props;

  const sendUpdate = useMemo(
    () => throttle((id: string, patch: ShapePatch) => latest.current.onOps([{ kind: 'update', id, patch }]), DRAG_SEND_MS),
    [],
  );
  useEffect(() => () => sendUpdate.cancel(), [sendUpdate]);

  const canManipulate = editable && !readOnly && tool === 'select';

  // Rendered shapes: server state + this client's in-flight drag/resize preview.
  const view = useMemo(() => {
    const ids = Object.keys(drafts);
    if (ids.length === 0) return shapes;
    const next = new Map(shapes);
    for (const id of ids) {
      const s = next.get(id);
      if (s) next.set(id, { ...s, ...drafts[id] } as Shape);
    }
    return next;
  }, [shapes, drafts]);

  // ---- sizing, fonts, lifecycle ----------------------------------------

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const next = { width: el.clientWidth, height: el.clientHeight };
      setSize(next);
      latest.current.onResize(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    // Konva draws text once; redraw after the web font arrives.
    void document.fonts?.ready.then(() => stageRef.current?.batchDraw());
  }, []);

  useEffect(() => {
    if (editable) return;
    sendUpdate.cancel();
    setDrafts({});
    setDrawing(null);
    drawingRef.current = null;
    setEditing(null);
  }, [editable, sendUpdate]);

  useEffect(() => {
    if (editing?.kind === 'existing' && !shapes.has(editing.id)) setEditing(null);
  }, [editing, shapes]);

  // ---- helpers -----------------------------------------------------------

  const setDraft = (id: string, patch: ShapePatch) => setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
  const clearDraft = (id: string) =>
    setDrafts((d) => {
      const { [id]: _removed, ...rest } = d;
      return rest;
    });

  /** Sends the final state of a drag/resize and drops its preview. */
  const finish = (id: string, patch: ShapePatch) => {
    sendUpdate.cancel();
    latest.current.onOps([{ kind: 'update', id, patch }]);
    clearDraft(id);
  };

  const pointerWorld = (): Point | null => {
    const p = stageRef.current?.getPointerPosition();
    return p ? screenToWorld(p, latest.current.viewport) : null;
  };

  const isConnectorTool = tool === 'line' || tool === 'arrow';

  // ---- stage events --------------------------------------------------------

  const commitDrawing = (to: Point) => {
    const d = drawingRef.current;
    drawingRef.current = null;
    setDrawing(null);
    setHoverTarget(null);
    if (!d) return;
    let shape: Shape | null;
    if (d.tool === 'rect' || d.tool === 'ellipse') {
      shape = createBox(d.tool, d.from, to, style);
    } else if (d.tool === 'line' || d.tool === 'arrow') {
      const end = hitTestBindable(to, view)?.id ?? null;
      shape = createConnector(d.tool, d.from, to, { start: d.start, end }, style, view);
    } else {
      shape = null;
    }
    if (!shape) return;
    props.onOps([{ kind: 'create', shape }]);
    props.onSelect(shape.id);
    props.onToolChange('select');
  };

  // A drag released outside the canvas still finishes the shape.
  useEffect(() => {
    if (!drawing) return;
    const onUp = () => drawingRef.current && commitDrawing(drawingRef.current.to);
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  });

  const onMouseDown = (e: KonvaEventObject<MouseEvent>) => {
    if (editing) {
      // A click outside the open text editor only finishes the edit. Blurring
      // commits it; starting a new action here would unmount the editor first
      // and lose what was typed.
      editorRef.current?.blur();
      return;
    }
    if (readOnly || tool === 'pan' || e.evt.button !== 0) return;
    const stage = e.target.getStage();
    if (tool === 'select') {
      if (e.target === stage) props.onSelect(null);
      return;
    }
    const p = pointerWorld();
    if (!editable || !p) return;
    e.evt.preventDefault();
    if (tool === 'text') {
      setEditing({ kind: 'new', at: p });
      return;
    }
    const d: Drawing = { tool, from: p, to: p, start: isConnectorTool ? (hitTestBindable(p, view)?.id ?? null) : null };
    drawingRef.current = d;
    setDrawing(d);
  };

  const onMouseMove = () => {
    const p = pointerWorld();
    if (!p) return;
    if (!readOnly) props.onCursor(p);
    if (drawingRef.current) {
      const d = { ...drawingRef.current, to: p };
      drawingRef.current = d;
      setDrawing(d);
    }
    if (isConnectorTool && editable) {
      const target = hitTestBindable(p, view)?.id ?? null;
      if (target !== hoverTarget) setHoverTarget(target);
    }
  };

  const onMouseUp = () => {
    if (drawingRef.current) commitDrawing(pointerWorld() ?? drawingRef.current.to);
  };

  const onMouseLeave = () => {
    props.onCursor(null);
    if (!drawingRef.current) setHoverTarget(null);
  };

  const onWheel = (e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const p = stageRef.current?.getPointerPosition();
    if (!p) return;
    // Trackpad pinch arrives as ctrl+wheel with small deltas.
    const factor = Math.exp(-e.evt.deltaY * (e.evt.ctrlKey ? 0.01 : 0.0015));
    props.onViewportChange(zoomAt(viewport, p, factor));
  };

  const onStageDrag = (e: KonvaEventObject<DragEvent>) => {
    const stage = stageRef.current;
    if (!stage || e.target !== stage) return; // shape drags bubble up here too
    props.onViewportChange({ ...viewport, x: stage.x(), y: stage.y() });
  };

  // ---- shape events ----------------------------------------------------------

  const select = (id: string) => () => {
    if (!readOnly && tool === 'select') props.onSelect(id);
  };

  const setCursorStyle = (cursor: string) => () => {
    const container = stageRef.current?.container();
    if (container) container.style.cursor = cursor;
  };
  const hoverHandlers = canManipulate
    ? { onMouseEnter: setCursorStyle('move'), onMouseLeave: setCursorStyle('') }
    : {};

  const moveHandlers = (id: string) => ({
    onDragMove: (e: KonvaEventObject<DragEvent>) => {
      const patch = { x: round(e.target.x()), y: round(e.target.y()) };
      setDraft(id, patch);
      sendUpdate(id, patch);
    },
    onDragEnd: (e: KonvaEventObject<DragEvent>) => finish(id, { x: round(e.target.x()), y: round(e.target.y()) }),
  });

  const resizePatch = (shape: Shape, node: Konva.Node): ShapePatch => {
    const sx = node.scaleX();
    const sy = node.scaleY();
    node.scale({ x: 1, y: 1 });
    if (shape.type === 'text') {
      const width = round(Math.max(24, node.width() * sx));
      node.width(width);
      return { x: round(node.x()), y: round(node.y()), width };
    }
    const width = round(Math.max(4, node.width() * sx));
    const height = round(Math.max(4, node.height() * sy));
    node.size({ width, height });
    return { x: round(node.x()), y: round(node.y()), width, height };
  };

  const resizeHandlers = (shape: Shape) => ({
    onTransform: (e: KonvaEventObject<Event>) => {
      const patch = resizePatch(shape, e.target);
      setDraft(shape.id, patch);
      sendUpdate(shape.id, patch);
    },
    onTransformEnd: (e: KonvaEventObject<Event>) => finish(shape.id, resizePatch(shape, e.target)),
  });

  const startEditing = (id: string) => () => {
    if (!canManipulate) return;
    props.onSelect(id);
    setEditing({ kind: 'existing', id });
  };

  // Connector body drag (only when neither end is attached): the node is moved
  // by an offset while the preview keeps the original points, so the two don't add up.
  const connectorDragHandlers = (conn: ConnectorShape) => {
    const moved = (node: Konva.Node) => ({
      x1: round(conn.x1 + node.x()),
      y1: round(conn.y1 + node.y()),
      x2: round(conn.x2 + node.x()),
      y2: round(conn.y2 + node.y()),
    });
    return {
      onDragStart: () => setDraft(conn.id, { x1: conn.x1, y1: conn.y1, x2: conn.x2, y2: conn.y2 }),
      onDragMove: (e: KonvaEventObject<DragEvent>) => sendUpdate(conn.id, moved(e.target)),
      onDragEnd: (e: KonvaEventObject<DragEvent>) => {
        const patch = moved(e.target);
        e.target.position({ x: 0, y: 0 });
        finish(conn.id, patch);
      },
    };
  };

  const endpointPatch = (conn: ConnectorShape, which: 'start' | 'end', p: Point, bind: boolean): ShapePatch => {
    const other = which === 'start' ? conn.end?.shapeId : conn.start?.shapeId;
    const target = bind ? hitTestBindable(p, view, conn.id) : undefined;
    const binding = target && target.id !== other ? { shapeId: target.id } : null;
    return which === 'start'
      ? { x1: round(p.x), y1: round(p.y), start: binding }
      : { x2: round(p.x), y2: round(p.y), end: binding };
  };

  const endpointHandlers = (conn: ConnectorShape, which: 'start' | 'end') => ({
    onDragMove: (e: KonvaEventObject<DragEvent>) => {
      const p = e.target.position();
      const patch = endpointPatch(conn, which, p, false);
      setDraft(conn.id, patch);
      sendUpdate(conn.id, patch);
      setHoverTarget(hitTestBindable(p, view, conn.id)?.id ?? null);
    },
    onDragEnd: (e: KonvaEventObject<DragEvent>) => {
      finish(conn.id, endpointPatch(conn, which, e.target.position(), true));
      setHoverTarget(null);
      // Remount the handles so they snap to the resolved endpoint.
      setHandleEpoch((n) => n + 1);
    },
  });

  // ---- transformer -------------------------------------------------------------

  const selected = selectedId ? view.get(selectedId) : undefined;
  const editingId = editing?.kind === 'existing' ? editing.id : null;
  const transformable = canManipulate && selected && !isConnector(selected) && editingId !== selected.id;

  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    const node = transformable && selectedId ? stageRef.current?.findOne(`#${selectedId}`) : undefined;
    tr.nodes(node ? [node] : []);
    tr.getLayer()?.batchDraw();
  });

  // ---- text editing --------------------------------------------------------------

  const commitText = (value: string) => {
    const current = editing;
    setEditing(null);
    if (!current || !editable) return;
    if (current.kind === 'new') {
      if (!value.trim()) return;
      const shape = createText(current.at, value, style);
      props.onOps([{ kind: 'create', shape }]);
      props.onSelect(shape.id);
      props.onToolChange('select');
      return;
    }
    const shape = shapes.get(current.id);
    if (!shape) return;
    if (shape.type === 'text') {
      if (!value.trim()) props.onOps(deleteOps(shape.id, shapes));
      else if (value !== shape.text) props.onOps([{ kind: 'update', id: shape.id, patch: { text: value } }]);
    } else if ((shape.type === 'rect' || shape.type === 'ellipse') && value !== shape.label) {
      props.onOps([{ kind: 'update', id: shape.id, patch: { label: value } }]);
    }
  };

  // ---- render --------------------------------------------------------------------

  const inv = 1 / viewport.scale;
  let gridSize = GRID * viewport.scale;
  while (gridSize < 12) gridSize *= 2;

  return (
    <div
      ref={wrapRef}
      className="stage-wrap"
      data-tool={tool}
      data-readonly={readOnly}
      style={{
        backgroundSize: `${gridSize}px ${gridSize}px`,
        backgroundPosition: `${viewport.x}px ${viewport.y}px`,
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {size.width > 0 && (
        <Stage
          ref={stageRef}
          width={size.width}
          height={size.height}
          x={viewport.x}
          y={viewport.y}
          scaleX={viewport.scale}
          scaleY={viewport.scale}
          draggable={readOnly || tool === 'pan' || tool === 'select'}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseLeave}
          onWheel={onWheel}
          onDragMove={onStageDrag}
          onDragEnd={onStageDrag}
        >
          <Layer ref={props.shapesLayerRef} listening={!readOnly}>
            {[...view.values()].map((shape) => {
              const common = { id: shape.id, onMouseDown: select(shape.id), ...hoverHandlers };
              switch (shape.type) {
                case 'rect':
                case 'ellipse':
                  return (
                    <BoxNode
                      key={shape.id}
                      {...common}
                      shape={shape}
                      draggable={canManipulate}
                      hideLabel={editingId === shape.id}
                      onDblClick={startEditing(shape.id)}
                      {...moveHandlers(shape.id)}
                      {...resizeHandlers(shape)}
                    />
                  );
                case 'text':
                  return (
                    <Text
                      key={shape.id}
                      {...common}
                      x={shape.x}
                      y={shape.y}
                      width={shape.width}
                      text={shape.text}
                      fontSize={shape.fontSize}
                      lineHeight={TEXT_LINE_HEIGHT}
                      fontFamily={FONT_FAMILY}
                      fill={shape.textColor}
                      opacity={editingId === shape.id ? 0 : 1}
                      draggable={canManipulate}
                      onDblClick={startEditing(shape.id)}
                      {...moveHandlers(shape.id)}
                      {...resizeHandlers(shape)}
                    />
                  );
                case 'line':
                case 'arrow': {
                  const seg = resolveConnector(shape, view);
                  const Comp = shape.type === 'arrow' ? Arrow : Line;
                  return (
                    <Comp
                      key={shape.id}
                      {...common}
                      points={[seg.x1, seg.y1, seg.x2, seg.y2]}
                      stroke={shape.stroke}
                      fill={shape.stroke}
                      strokeWidth={2}
                      pointerLength={12}
                      pointerWidth={11}
                      lineCap="round"
                      lineJoin="round"
                      hitStrokeWidth={14}
                      draggable={canManipulate && !shape.start && !shape.end}
                      {...connectorDragHandlers(shape)}
                    />
                  );
                }
              }
            })}
          </Layer>

          <Layer>
            {hoverTarget && <TargetHighlight shape={view.get(hoverTarget)} inv={inv} />}
            {drawing && <DrawingPreview drawing={drawing} style={style} shapes={view} inv={inv} />}

            {selected && canManipulate && isConnector(selected) && (
              <ConnectorSelection key={handleEpoch} conn={selected} shapes={view} inv={inv} handlers={endpointHandlers} />
            )}
            {selected && !canManipulate && !readOnly && <SelectionOutline shape={selected} shapes={view} inv={inv} />}

            <Transformer
              ref={trRef}
              rotateEnabled={false}
              flipEnabled={false}
              keepRatio={false}
              ignoreStroke
              borderStroke={SELECTION}
              anchorStroke={SELECTION}
              anchorSize={9}
              anchorCornerRadius={2}
              enabledAnchors={
                selected?.type === 'text'
                  ? ['middle-left', 'middle-right']
                  : ['top-left', 'top-center', 'top-right', 'middle-right', 'bottom-right', 'bottom-center', 'bottom-left', 'middle-left']
              }
              boundBoxFunc={(oldBox, newBox) => (newBox.width < 4 || newBox.height < 4 ? oldBox : newBox)}
            />

            {cursors.map((c) => (
              <RemoteCursorMark key={c.participantId} cursor={c} inv={inv} />
            ))}
          </Layer>
        </Stage>
      )}

      {editing && (
        <TextEditor
          ref={editorRef}
          key={editing.kind === 'new' ? `new-${editing.at.x}-${editing.at.y}` : editing.id}
          editing={editing}
          shapes={shapes}
          style={style}
          viewport={viewport}
          onCommit={commitText}
        />
      )}
    </div>
  );
}

// ---- pieces -----------------------------------------------------------------------

type BoxNodeProps = {
  id: string;
  shape: BoxShape;
  draggable: boolean;
  hideLabel: boolean;
  onMouseDown(): void;
  onDblClick(): void;
  onDragMove(e: KonvaEventObject<DragEvent>): void;
  onDragEnd(e: KonvaEventObject<DragEvent>): void;
  onTransform(e: KonvaEventObject<Event>): void;
  onTransformEnd(e: KonvaEventObject<Event>): void;
  onMouseEnter?(): void;
  onMouseLeave?(): void;
};

/** A rect or ellipse with its centred label. Both are top-left/width/height boxes, so one Transformer fits both. */
function BoxNode({ shape, hideLabel, ...handlers }: BoxNodeProps) {
  const body = {
    ...handlers,
    x: shape.x,
    y: shape.y,
    width: shape.width,
    height: shape.height,
    fill: shape.fill,
    stroke: shape.stroke,
    strokeWidth: 2,
  };
  return (
    <>
      {shape.type === 'rect' ? (
        <Rect {...body} cornerRadius={6} />
      ) : (
        <KShape
          {...body}
          sceneFunc={(ctx, node) => {
            const w = node.width();
            const h = node.height();
            ctx.beginPath();
            ctx.ellipse(w / 2, h / 2, Math.max(0, w / 2), Math.max(0, h / 2), 0, 0, Math.PI * 2);
            ctx.closePath();
            ctx.fillStrokeShape(node);
          }}
        />
      )}
      {shape.label && !hideLabel && (
        <Text
          x={shape.x}
          y={shape.y}
          width={shape.width}
          height={shape.height}
          padding={LABEL_PADDING}
          text={shape.label}
          align="center"
          verticalAlign="middle"
          fontSize={LABEL_FONT_SIZE}
          lineHeight={TEXT_LINE_HEIGHT}
          fontFamily={FONT_FAMILY}
          fill={shape.textColor}
          wrap="word"
          listening={false}
        />
      )}
    </>
  );
}

function TargetHighlight({ shape, inv }: { shape: Shape | undefined; inv: number }) {
  if (!isBindable(shape)) return null;
  const b = boxOf(shape);
  const pad = 6 * inv;
  return (
    <Rect
      x={b.x - pad}
      y={b.y - pad}
      width={b.width + pad * 2}
      height={b.height + pad * 2}
      stroke={SELECTION}
      strokeWidth={1.5 * inv}
      dash={[5 * inv, 4 * inv]}
      cornerRadius={8 * inv}
      listening={false}
    />
  );
}

function DrawingPreview({ drawing, style, shapes, inv }: { drawing: Drawing; style: Style; shapes: ShapeMap; inv: number }) {
  const dash = [6 * inv, 4 * inv];
  if (drawing.tool === 'rect' || drawing.tool === 'ellipse') {
    const r = normalizeRect(drawing.from, drawing.to);
    const props = { stroke: style.stroke, strokeWidth: 2, dash, listening: false, fill: style.fill === 'transparent' ? undefined : style.fill, opacity: 0.85 };
    return drawing.tool === 'rect' ? (
      <Rect {...r} {...props} cornerRadius={6} />
    ) : (
      <KShape
        {...r}
        {...props}
        sceneFunc={(ctx, node) => {
          ctx.beginPath();
          ctx.ellipse(node.width() / 2, node.height() / 2, node.width() / 2, node.height() / 2, 0, 0, Math.PI * 2);
          ctx.closePath();
          ctx.fillStrokeShape(node);
        }}
      />
    );
  }
  if (drawing.tool === 'line' || drawing.tool === 'arrow') {
    const start = drawing.start ? shapes.get(drawing.start) : undefined;
    const from = isBindable(start) ? centerOf(start) : drawing.from;
    const Comp = drawing.tool === 'arrow' ? Arrow : Line;
    return (
      <Comp
        points={[from.x, from.y, drawing.to.x, drawing.to.y]}
        stroke={style.stroke}
        fill={style.stroke}
        strokeWidth={2}
        dash={dash}
        pointerLength={12}
        pointerWidth={11}
        listening={false}
      />
    );
  }
  return null;
}

function centerOf(shape: Exclude<Shape, ConnectorShape>): Point {
  const b = boxOf(shape);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

function ConnectorSelection({
  conn,
  shapes,
  inv,
  handlers,
}: {
  conn: ConnectorShape;
  shapes: ShapeMap;
  inv: number;
  handlers: (conn: ConnectorShape, which: 'start' | 'end') => object;
}) {
  const seg = resolveConnector(conn, shapes);
  const handle = (which: 'start' | 'end', p: Point, bound: boolean) => (
    <Circle
      x={p.x}
      y={p.y}
      radius={6 * inv}
      fill={bound ? SELECTION : '#ffffff'}
      stroke={SELECTION}
      strokeWidth={2 * inv}
      hitStrokeWidth={10 * inv}
      draggable
      {...handlers(conn, which)}
    />
  );
  return (
    <>
      <Line points={[seg.x1, seg.y1, seg.x2, seg.y2]} stroke={SELECTION} strokeWidth={1 * inv} dash={[4 * inv, 3 * inv]} listening={false} />
      {handle('start', { x: seg.x1, y: seg.y1 }, !!conn.start)}
      {handle('end', { x: seg.x2, y: seg.y2 }, !!conn.end)}
    </>
  );
}

function SelectionOutline({ shape, shapes, inv }: { shape: Shape; shapes: ShapeMap; inv: number }) {
  let b;
  if (isConnector(shape)) {
    const s = resolveConnector(shape, shapes);
    b = normalizeRect({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 });
  } else {
    b = boxOf(shape);
  }
  return <Rect {...b} stroke={SELECTION} strokeWidth={1 * inv} dash={[4 * inv, 3 * inv]} listening={false} />;
}

const CURSOR_PATH = 'M0 0 L0 17 L4.6 12.6 L7.8 19.6 L10.9 18.3 L7.8 11.5 L13.6 11.5 Z';

function RemoteCursorMark({ cursor, inv }: { cursor: RemoteCursor; inv: number }) {
  return (
    <Group x={cursor.position.x} y={cursor.position.y} scaleX={inv} scaleY={inv} listening={false}>
      <Path data={CURSOR_PATH} fill={cursor.color} stroke="#ffffff" strokeWidth={1.2} />
      <Label x={13} y={19}>
        <Tag fill={cursor.color} cornerRadius={4} />
        <Text text={cursor.name} fontSize={12} fontFamily={FONT_FAMILY} fill="#ffffff" padding={5} />
      </Label>
    </Group>
  );
}

function TextEditor({
  ref,
  editing,
  shapes,
  style,
  viewport,
  onCommit,
}: {
  ref: RefObject<HTMLTextAreaElement | null>;
  editing: Editing;
  shapes: ShapeMap;
  style: Style;
  viewport: Viewport;
  onCommit(value: string): void;
}) {
  const shape = editing.kind === 'existing' ? shapes.get(editing.id) : undefined;
  const isBox = shape?.type === 'rect' || shape?.type === 'ellipse';
  const text = shape as TextShape | undefined;
  const initial = shape?.type === 'text' ? shape.text : isBox ? (shape as BoxShape).label : '';

  const world = isBox
    ? boxOf(shape as BoxShape)
    : editing.kind === 'new'
      ? { x: editing.at.x, y: editing.at.y, width: DEFAULT_TEXT_WIDTH, height: 0 }
      : { x: text!.x, y: text!.y, width: text!.width, height: 0 };
  const fontSize = (isBox ? LABEL_FONT_SIZE : (text?.fontSize ?? DEFAULT_FONT_SIZE)) * viewport.scale;
  const color = shape && 'textColor' in shape ? shape.textColor : style.textColor;
  const topLeft = worldToScreen(world, viewport);
  const pad = isBox ? LABEL_PADDING * viewport.scale : 0;

  const autosize = () => {
    const el = ref.current;
    if (!el || isBox) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    autosize();
  }, []);

  return (
    <textarea
      ref={ref}
      className="text-editor"
      data-centered={isBox}
      aria-label={isBox ? 'Shape label' : 'Text'}
      defaultValue={initial}
      // UTF-16 units: at most the server's code-point limit, so typed text is never rejected.
      maxLength={isBox ? 2000 : 5000}
      spellCheck={false}
      onInput={autosize}
      onBlur={(e) => onCommit(e.target.value)}
      style={{
        left: topLeft.x,
        top: topLeft.y,
        width: world.width * viewport.scale,
        height: isBox ? world.height * viewport.scale : undefined,
        padding: pad,
        paddingTop: isBox ? Math.max(pad, (world.height * viewport.scale - fontSize * TEXT_LINE_HEIGHT) / 2) : 0,
        fontSize,
        lineHeight: TEXT_LINE_HEIGHT,
        color,
      }}
    />
  );
}
