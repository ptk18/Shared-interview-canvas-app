import type Konva from 'konva';
import { useCallback, useEffect, useRef, useState } from 'react';
import { exportDiagramPng } from '../canvas/exportPng';
import { diagramBounds, fitViewport, type Viewport, zoomAt } from '../canvas/geometry';
import type { ShapeMap } from '../canvas/ops';
import {
  DEFAULT_STYLE,
  deleteOps,
  type Style,
  type StyleKey,
  styleKeysFor,
  stylePatch,
  type Tool,
} from '../canvas/shapes';
import type { RoomSession, RoomState } from '../room/roomSession';
import { useBackend } from '../services';
import type { Op, OpRejectionCode, Room, Shape } from '../services/protocol';
import { CopyLinkButton } from './CopyLinkButton';
import { EndSessionDialog } from './EndSessionDialog';
import { BrandMark, icons } from './icons';
import { StatusPills, StylePanel, Toolbar, ZoomControls } from './Panels';
import { Whiteboard } from './Whiteboard';

export interface EditorProps {
  room: Room;
  shapes: ShapeMap;
  /** Present while connected to a live session; absent for read-only review. */
  live?: { session: RoomSession; state: RoomState };
}

const REJECTION_TEXT: Record<OpRejectionCode, string> = {
  shape_not_found: 'That shape was just deleted by your partner.',
  duplicate_id: 'That change conflicted with another one and was skipped.',
  invalid_binding: 'The shape that connector was attached to no longer exists.',
  canvas_full: 'This canvas has reached its 2,000-shape limit.',
  room_completed: 'The session has ended; changes are no longer accepted.',
  invalid_op: 'The server rejected that change.',
};

const TOOL_STYLE_KEYS: Partial<Record<Tool, StyleKey[]>> = {
  rect: ['fill', 'stroke', 'textColor'],
  ellipse: ['fill', 'stroke', 'textColor'],
  line: ['stroke'],
  arrow: ['stroke'],
  text: ['textColor'],
};

function formatDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function Editor({ room, shapes, live }: EditorProps) {
  const backend = useBackend();
  const state = live?.state;
  const readOnly = !live || !!state?.ended;
  const editable = !readOnly && !!state?.canEdit;

  const [tool, setTool] = useState<Tool>(readOnly ? 'pan' : 'select');
  const [style, setStyle] = useState<Style>(DEFAULT_STYLE);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const shapesLayerRef = useRef<Konva.Layer>(null);
  const shapesRef = useRef(shapes);
  shapesRef.current = shapes;

  // ---- derived state & effects ------------------------------------------

  useEffect(() => {
    if (!readOnly) return;
    setTool('pan');
    setSelectedId(null);
    setConfirmingEnd(false);
  }, [readOnly]);

  useEffect(() => {
    if (selectedId && !shapes.has(selectedId)) setSelectedId(null);
  }, [shapes, selectedId]);

  // Frame the existing diagram once the canvas has a size.
  useEffect(() => {
    if (!viewport && size.width > 0) setViewport(fitViewport(diagramBounds(shapesRef.current), size));
  }, [size, viewport]);

  useEffect(() => {
    if (state?.rejection) setNotice(REJECTION_TEXT[state.rejection.code] ?? state.rejection.message);
  }, [state?.rejection]);

  useEffect(() => {
    if (!state?.error) return;
    setNotice(
      state.error.code === 'save_failed'
        ? 'Couldn’t save the final canvas, so the session is still open. Try again in a moment.'
        : state.error.message,
    );
  }, [state?.error]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4500);
    return () => clearTimeout(t);
  }, [notice]);

  const vp = viewport ?? { x: size.width / 2, y: size.height / 2, scale: 1 };

  // ---- actions -------------------------------------------------------------

  const applyOps = useCallback(
    (ops: Op[]) => {
      if (!live) return;
      for (const op of ops) live.session.apply(op);
    },
    [live],
  );

  const onCursor = useCallback((p: { x: number; y: number } | null) => live?.session.sendCursor(p), [live]);

  const selected: Shape | undefined = selectedId ? shapes.get(selectedId) : undefined;
  const styleKeys = selected ? styleKeysFor(selected) : (TOOL_STYLE_KEYS[tool] ?? []);
  const styleValues: Partial<Record<StyleKey, string>> = selected
    ? (Object.fromEntries(styleKeys.map((k) => [k, (selected as unknown as Record<string, string>)[k]])) as Partial<
        Record<StyleKey, string>
      >)
    : style;

  function onStyleChange(key: StyleKey, color: string) {
    setStyle((s) => ({ ...s, [key]: color }));
    if (!selected) return;
    const patch = stylePatch(selected, key, color);
    if (patch) applyOps([{ kind: 'update', id: selected.id, patch }]);
  }

  function onDelete() {
    if (!selectedId || !editable) return;
    applyOps(deleteOps(selectedId, shapes));
    setSelectedId(null);
  }

  function onTool(next: Tool) {
    setTool(next);
    if (next !== 'select') setSelectedId(null);
  }

  async function onExport() {
    const layer = shapesLayerRef.current;
    if (!layer) return;
    const ok = await exportDiagramPng(layer, shapes, vp, room.title);
    if (!ok) setNotice('Nothing to export yet. The canvas is empty.');
  }

  const zoomBy = (factor: number) => setViewport(zoomAt(vp, { x: size.width / 2, y: size.height / 2 }, factor));
  const resetZoom = () => zoomBy(1 / vp.scale);
  const fit = () => setViewport(fitViewport(diagramBounds(shapes), size));

  // ---- render ------------------------------------------------------------------

  const connection = state?.connection;
  const showConnectionBanner = !!live && !readOnly && connection !== 'connected';

  return (
    <div className="editor">
      <header className="topbar">
        <div className="topbar-title">
          <a href="/" aria-label="Sketchroom home" style={{ display: 'flex' }}>
            <BrandMark />
          </a>
          <h1 title={room.title}>{room.title}</h1>
          {readOnly && <span className="readonly-badge">Read-only</span>}
          {readOnly && room.completedAt && (
            <span className="topbar-meta hide-narrow">Ended {formatDate(room.completedAt)}</span>
          )}
          {backend.kind === 'mock' && (
            <span className="mock-badge hide-narrow">
              mock backend
              {live && !readOnly && backend.simulateNetworkDrop && (
                <button type="button" className="link-btn" onClick={() => backend.simulateNetworkDrop?.()}>
                  simulate drop
                </button>
              )}
            </span>
          )}
        </div>
        <div className="topbar-actions">
          {live && !readOnly && state && (
            <>
              <StatusPills connection={state.connection} save={state.save} />
              <span className="divider-v hide-narrow" />
            </>
          )}
          <CopyLinkButton roomId={room.id} compact />
          <button type="button" className="btn" onClick={onExport}>
            {icons.download}
            <span className="hide-narrow">Export PNG</span>
          </button>
          {live && !readOnly && (
            <button
              type="button"
              className="btn btn-danger"
              aria-label="End session"
              disabled={!editable}
              onClick={() => setConfirmingEnd(true)}
            >
              End<span className="hide-narrow">&nbsp;session</span>
            </button>
          )}
        </div>
      </header>

      <div style={{ position: 'relative', minHeight: 0 }}>
        <Whiteboard
          shapes={shapes}
          tool={tool}
          editable={editable}
          readOnly={readOnly}
          style={style}
          selectedId={selectedId}
          viewport={vp}
          cursors={readOnly ? [] : (state?.cursors ?? [])}
          shapesLayerRef={shapesLayerRef}
          onResize={setSize}
          onSelect={setSelectedId}
          onToolChange={setTool}
          onViewportChange={setViewport}
          onOps={applyOps}
          onCursor={onCursor}
        />

        {!readOnly && (
          <Toolbar tool={tool} editable={editable} canDelete={editable && !!selected} onTool={onTool} onDelete={onDelete} />
        )}
        {!readOnly && <StylePanel keys={styleKeys} values={styleValues} disabled={!editable} onChange={onStyleChange} />}
        <ZoomControls scale={vp.scale} onZoom={zoomBy} onReset={resetZoom} onFit={fit} />

        {showConnectionBanner && (
          <div className="panel banner" data-tone="warn" role="status">
            {connection === 'disconnected' ? (
              <>
                <span>Disconnected. Editing is disabled.</span>
                <button type="button" className="btn" onClick={() => live.session.retry()}>
                  Reconnect
                </button>
              </>
            ) : (
              <span>
                {connection === 'connecting' ? 'Connecting…' : 'Connection lost. Editing is paused while we reconnect…'}
              </span>
            )}
          </div>
        )}
        {readOnly && live && (
          <div className="panel banner" data-tone="info" role="status">
            The session has ended. This diagram is now read-only.
          </div>
        )}
        {notice && (
          <div className="panel toast" role="status">
            {notice}
          </div>
        )}
      </div>

      {confirmingEnd && live && (
        <EndSessionDialog
          onCancel={() => setConfirmingEnd(false)}
          onConfirm={() => {
            live.session.endSession();
            setConfirmingEnd(false);
          }}
        />
      )}
    </div>
  );
}
