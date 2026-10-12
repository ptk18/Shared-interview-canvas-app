// TypeScript mirror of _docs/protocol.md. Every backend (FastAPI or mock) speaks this.

export type RoomStatus = 'active' | 'completed';

export interface Room {
  id: string;
  title: string;
  status: RoomStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface Binding {
  shapeId: string;
}

export interface BoxShape {
  id: string;
  type: 'rect' | 'ellipse';
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  stroke: string;
  label: string;
  textColor: string;
}

export interface TextShape {
  id: string;
  type: 'text';
  x: number;
  y: number;
  width: number;
  text: string;
  fontSize: number;
  textColor: string;
}

export interface ConnectorShape {
  id: string;
  type: 'line' | 'arrow';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  start: Binding | null;
  end: Binding | null;
}

export type Shape = BoxShape | TextShape | ConnectorShape;
export type ShapeType = Shape['type'];

/** Fields an update may touch: everything except the immutable `id` and `type`. */
export type ShapePatch =
  | Partial<Omit<BoxShape, 'id' | 'type'>>
  | Partial<Omit<TextShape, 'id' | 'type'>>
  | Partial<Omit<ConnectorShape, 'id' | 'type'>>;

export type Op =
  | { kind: 'create'; shape: Shape }
  | { kind: 'update'; id: string; patch: ShapePatch }
  | { kind: 'delete'; id: string };

export interface Canvas {
  revision: number;
  shapes: Shape[];
}

export interface RoomDetail extends Room {
  canvas: Canvas;
}

export interface Participant {
  id: string;
  name: string;
  color: string;
}

export interface Point {
  x: number;
  y: number;
}

export type OpRejectionCode =
  | 'invalid_op'
  | 'duplicate_id'
  | 'shape_not_found'
  | 'invalid_binding'
  | 'canvas_full'
  | 'room_completed';

export type ServerMessage =
  | {
      type: 'welcome';
      participant: Participant;
      token: string;
      room: Room;
      canvas: Canvas;
      savedRevision: number;
      participants: Participant[];
    }
  | { type: 'op'; revision: number; op: Op; participantId: string; clientOpId: string }
  | { type: 'op_rejected'; clientOpId: string; code: OpRejectionCode; message: string }
  | {
      type: 'cursor';
      participantId: string;
      name: string;
      color: string;
      position: Point | null;
    }
  | { type: 'participant_joined'; participant: Participant }
  | { type: 'participant_left'; participantId: string }
  | { type: 'saved'; revision: number }
  | { type: 'save_failed'; message: string }
  | { type: 'session_ended'; room: Room; canvas: Canvas }
  | { type: 'error'; code: string; message: string };

export type ClientMessage =
  | { type: 'op'; clientOpId: string; op: Op }
  | { type: 'cursor'; position: Point | null }
  | { type: 'end_session' };

/** WebSocket close codes after which the client must not reconnect. */
export const CloseCode = {
  InvalidName: 4000,
  Replaced: 4001,
  RoomFull: 4003,
  RoomNotFound: 4004,
  RoomCompleted: 4009,
} as const;

export const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set(Object.values(CloseCode));

export const MAX_PARTICIPANTS = 2;
export const MAX_SHAPES = 2000;
export const MAX_TITLE_LENGTH = 120;
export const MAX_NAME_LENGTH = 40;
export const PARTICIPANT_COLORS = ['#e8590c', '#1c7ed6'] as const;
