import { type ReactNode } from 'react';
import type { Tool, StyleKey } from '../canvas/shapes';
import type { ConnectionState, SaveState } from '../room/roomSession';
import { icons } from './icons';

const TOOLS: { tool: Tool; label: string; icon: ReactNode }[] = [
  { tool: 'select', label: 'Select and move', icon: icons.select },
  { tool: 'pan', label: 'Pan the canvas', icon: icons.pan },
  { tool: 'rect', label: 'Rectangle', icon: icons.rect },
  { tool: 'ellipse', label: 'Ellipse', icon: icons.ellipse },
  { tool: 'arrow', label: 'Arrow', icon: icons.arrow },
  { tool: 'line', label: 'Line', icon: icons.line },
  { tool: 'text', label: 'Add text', icon: icons.text },
];

export function Toolbar(props: {
  tool: Tool;
  editable: boolean;
  canDelete: boolean;
  onTool(tool: Tool): void;
  onDelete(): void;
}) {
  return (
    <div className="panel toolbar" role="toolbar" aria-label="Drawing tools" aria-orientation="vertical">
      {TOOLS.map(({ tool, label, icon }) => (
        <button
          key={tool}
          type="button"
          className="tool-btn"
          title={label}
          aria-label={label}
          aria-pressed={props.tool === tool}
          disabled={!props.editable && tool !== 'pan' && tool !== 'select'}
          onClick={() => props.onTool(tool)}
        >
          {icon}
        </button>
      ))}
      <div className="toolbar-sep" />
      <button
        type="button"
        className="tool-btn danger"
        title="Delete selected shape"
        aria-label="Delete selected shape"
        disabled={!props.canDelete}
        onClick={props.onDelete}
      >
        {icons.trash}
      </button>
    </div>
  );
}

export const FILL_COLORS = ['transparent', '#ffffff', '#fff3bf', '#d3f9d8', '#d0ebff', '#e5dbff', '#ffe3e3', '#f1f3f5'];
export const INK_COLORS = ['#1f2328', '#868e96', '#1971c2', '#2f9e44', '#e8590c', '#e03131', '#7048e8', '#0c8599'];

const ROWS: { key: StyleKey; label: string; colors: string[] }[] = [
  { key: 'fill', label: 'Fill', colors: FILL_COLORS },
  { key: 'stroke', label: 'Line', colors: INK_COLORS },
  { key: 'textColor', label: 'Text', colors: INK_COLORS },
];

const COLOR_NAMES: Record<string, string> = {
  transparent: 'No fill',
  '#ffffff': 'White',
  '#fff3bf': 'Yellow',
  '#d3f9d8': 'Green',
  '#d0ebff': 'Blue',
  '#e5dbff': 'Violet',
  '#ffe3e3': 'Red',
  '#f1f3f5': 'Grey',
  '#1f2328': 'Ink',
  '#868e96': 'Grey',
  '#1971c2': 'Blue',
  '#2f9e44': 'Green',
  '#e8590c': 'Orange',
  '#e03131': 'Red',
  '#7048e8': 'Violet',
  '#0c8599': 'Teal',
};

export function StylePanel(props: {
  keys: StyleKey[];
  values: Partial<Record<StyleKey, string>>;
  disabled: boolean;
  onChange(key: StyleKey, color: string): void;
}) {
  const rows = ROWS.filter((r) => props.keys.includes(r.key));
  if (rows.length === 0) return null;
  return (
    <div className="panel style-panel" aria-label="Colours">
      {rows.map((row) => (
        <div className="style-row" key={row.key} role="group" aria-label={`${row.label} colour`}>
          <span className="style-row-label" aria-hidden="true">
            {row.label}
          </span>
          <div className="swatches">
            {row.colors.map((color) => (
              <button
                key={color}
                type="button"
                className="swatch"
                style={color === 'transparent' ? undefined : { background: color }}
                data-transparent={color === 'transparent'}
                aria-label={`${row.label}: ${COLOR_NAMES[color] ?? color}`}
                aria-pressed={props.values[row.key]?.toLowerCase() === color}
                disabled={props.disabled}
                onClick={() => props.onChange(row.key, color)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ZoomControls(props: { scale: number; onZoom(factor: number): void; onReset(): void; onFit(): void }) {
  return (
    <div className="panel zoom-panel" role="group" aria-label="Zoom">
      <button type="button" className="tool-btn" aria-label="Zoom out" title="Zoom out" onClick={() => props.onZoom(1 / 1.2)}>
        {icons.minus}
      </button>
      <button type="button" className="zoom-label" title="Reset to 100%" onClick={props.onReset}>
        {Math.round(props.scale * 100)}%
      </button>
      <button type="button" className="tool-btn" aria-label="Zoom in" title="Zoom in" onClick={() => props.onZoom(1.2)}>
        {icons.plus}
      </button>
      <button type="button" className="tool-btn" aria-label="Fit diagram to screen" title="Fit diagram" onClick={props.onFit}>
        {icons.fit}
      </button>
    </div>
  );
}

const CONNECTION: Record<ConnectionState, { label: string; tone: string }> = {
  connecting: { label: 'Connecting', tone: 'warn' },
  connected: { label: 'Connected', tone: 'ok' },
  reconnecting: { label: 'Reconnecting', tone: 'warn' },
  disconnected: { label: 'Disconnected', tone: 'danger' },
};

const SAVE: Record<SaveState, { label: string; tone: string }> = {
  saving: { label: 'Saving', tone: 'warn' },
  saved: { label: 'Saved', tone: 'neutral' },
  error: { label: 'Save failed', tone: 'danger' },
};

export function StatusPills({ connection, save }: { connection: ConnectionState; save: SaveState }) {
  const c = CONNECTION[connection];
  const s = SAVE[save];
  return (
    <>
      <span className="pill" data-kind="connection" data-tone={c.tone} role="status" aria-label={`Connection: ${c.label}`}>
        <span className="pill-dot" />
        <span className="pill-text">{c.label}</span>
      </span>
      <span className="pill" data-tone={s.tone} role="status" aria-label={`Save status: ${s.label}`}>
        <span className="pill-dot" />
        <span className="pill-text">{s.label}</span>
      </span>
    </>
  );
}
