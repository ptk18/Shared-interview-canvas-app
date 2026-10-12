import { applyOp, type ShapeMap, toShapeMap } from '../canvas/ops';
import type { Op, OpRejectionCode, Participant, Point, Room, ServerMessage } from '../services/protocol';
import { CloseCode, FATAL_CLOSE_CODES } from '../services/protocol';
import type { BackendService, RoomSocket } from '../services/types';
import { throttle } from './throttle';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
export type SaveState = 'saved' | 'saving' | 'error';
export type FatalReason = 'invalid_name' | 'replaced' | 'room_full' | 'room_not_found' | 'room_completed';

export interface RemoteCursor {
  participantId: string;
  name: string;
  color: string;
  position: Point;
}

export interface RoomState {
  connection: ConnectionState;
  save: SaveState;
  room: Room | null;
  me: Participant | null;
  /** What to render: the server-confirmed canvas with this client's unconfirmed ops on top. */
  shapes: ShapeMap;
  revision: number;
  cursors: RemoteCursor[];
  /** The session was completed while we were in it; the canvas is now read-only. */
  ended: boolean;
  /** Set when the server refused us for good; no reconnect will be attempted. */
  fatal: FatalReason | null;
  /** The most recent op the server rejected, for a transient notice. */
  rejection: { code: OpRejectionCode; message: string; at: number } | null;
  /** The last session-level error from the server (e.g. ending the session failed). */
  error: { code: string; message: string; at: number } | null;
  canEdit: boolean;
}

export interface TokenStore {
  get(roomId: string): string | null;
  set(roomId: string, token: string): void;
}

export interface RoomSessionOptions {
  backend: BackendService;
  roomId: string;
  name: string;
  tokens: TokenStore;
  /** Delay before each reconnect attempt; the session gives up after the last one. */
  reconnectDelaysMs?: number[];
  cursorThrottleMs?: number;
  /** Treat the connection as dead when an edit goes unacknowledged this long. */
  ackTimeoutMs?: number;
}

const ABNORMAL_CLOSURE = 1006;
const DEFAULT_RECONNECT_DELAYS = [250, 500, 1000, 2000, 4000, 5000, 5000, 5000, 5000, 5000, 5000, 5000];

const FATAL_BY_CODE: Record<number, FatalReason> = {
  [CloseCode.InvalidName]: 'invalid_name',
  [CloseCode.Replaced]: 'replaced',
  [CloseCode.RoomFull]: 'room_full',
  [CloseCode.RoomNotFound]: 'room_not_found',
  [CloseCode.RoomCompleted]: 'room_completed',
};

interface PendingOp {
  clientOpId: string;
  op: Op;
  sentAt: number;
}

/**
 * Client side of a room connection. Holds the server-confirmed canvas plus this
 * client's in-flight ops, applies server ops strictly in revision order, and
 * reconnects (reloading the authoritative canvas) after interruptions.
 * Framework-agnostic; React binds to it through `subscribe`/`getState`.
 */
export class RoomSession {
  private readonly backend: BackendService;
  private readonly roomId: string;
  private readonly name: string;
  private readonly tokens: TokenStore;
  private readonly reconnectDelays: number[];
  private readonly ackTimeoutMs: number;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;

  private socket: RoomSocket | null = null;
  private confirmed: ShapeMap = new Map();
  private pending: PendingOp[] = [];
  private savedRevision = 0;
  private saveFailed = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private opCounter = 0;
  private readonly cursorMap = new Map<string, RemoteCursor>();
  private readonly listeners = new Set<() => void>();
  private state: RoomState;

  readonly sendCursor: ((position: Point | null) => void) & { cancel(): void };

  constructor(options: RoomSessionOptions) {
    this.backend = options.backend;
    this.roomId = options.roomId;
    this.name = options.name;
    this.tokens = options.tokens;
    this.reconnectDelays = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS;
    this.ackTimeoutMs = options.ackTimeoutMs ?? 8_000;
    this.sendCursor = throttle((position: Point | null) => {
      if (this.state.connection === 'connected') this.socket?.send({ type: 'cursor', position });
    }, options.cursorThrottleMs ?? 50);
    this.state = {
      connection: 'connecting',
      save: 'saved',
      room: null,
      me: null,
      shapes: this.confirmed,
      revision: 0,
      cursors: [],
      ended: false,
      fatal: null,
      rejection: null,
      error: null,
      canEdit: false,
    };
  }

  // ---- React binding -------------------------------------------------------

  getState = (): RoomState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  // ---- lifecycle ------------------------------------------------------------

  start(): void {
    this.open();
  }

  /** Reconnect manually after giving up (`disconnected`). */
  retry(): void {
    if (this.disposed || this.state.ended || this.state.connection !== 'disconnected') return;
    this.attempt = 0;
    this.update({ connection: 'connecting', fatal: null });
    this.open();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.ackTimer);
    this.sendCursor.cancel();
    this.socket?.close();
    this.socket = null;
    this.listeners.clear();
  }

  // ---- editing --------------------------------------------------------------

  /** Applies an op optimistically and sends it. Returns false if editing is not possible right now. */
  apply(op: Op): boolean {
    if (!this.state.canEdit || !this.socket) return false;
    const clientOpId = `c${++this.opCounter}_${Math.random().toString(36).slice(2, 8)}`;
    this.pending.push({ clientOpId, op, sentAt: Date.now() });
    this.socket.send({ type: 'op', clientOpId, op });
    this.watchAcks();
    this.refresh();
    return true;
  }

  endSession(): void {
    if (this.state.canEdit) this.socket?.send({ type: 'end_session' });
  }

  // ---- connection -----------------------------------------------------------

  private open(): void {
    if (this.disposed) return;
    const socket = this.backend.connectRoom(
      this.roomId,
      { name: this.name, token: this.tokens.get(this.roomId) },
      {
        onOpen: () => {},
        onMessage: (message) => {
          if (this.socket === socket) this.receive(message);
        },
        onClose: ({ code }) => {
          if (this.socket === socket) this.closed(code);
        },
      },
    );
    this.socket = socket;
  }

  /**
   * A socket can go half-open (sleep, Wi-Fi switch) without the browser noticing
   * for minutes. If an edit isn't acknowledged in time, abandon the connection
   * and reconnect, rather than letting edits pile up unsaved.
   */
  private watchAcks(): void {
    clearTimeout(this.ackTimer);
    const oldest = this.pending[0];
    if (!oldest) return;
    this.ackTimer = setTimeout(
      () => {
        if (this.pending[0] !== oldest || !this.socket) return;
        this.socket.close({ reconnecting: true });
        this.closed(ABNORMAL_CLOSURE);
      },
      Math.max(0, oldest.sentAt + this.ackTimeoutMs - Date.now()),
    );
  }

  private closed(code: number): void {
    clearTimeout(this.ackTimer);
    this.socket = null;
    this.sendCursor.cancel();
    this.cursorMap.clear();
    // No offline editing: unconfirmed ops are dropped and the canvas reverts to
    // the last confirmed state until the reconnect delivers the server's.
    this.pending = [];

    if (this.state.ended) {
      this.update({ connection: 'disconnected', canEdit: false });
      return;
    }
    if (FATAL_CLOSE_CODES.has(code)) {
      this.update({ connection: 'disconnected', fatal: FATAL_BY_CODE[code] ?? null, canEdit: false });
      return;
    }
    const delay = this.reconnectDelays[this.attempt];
    if (delay === undefined) {
      this.update({ connection: 'disconnected', canEdit: false });
      return;
    }
    this.attempt += 1;
    this.update({ connection: 'reconnecting', canEdit: false });
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private receive(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome':
        this.attempt = 0;
        this.tokens.set(this.roomId, message.token);
        this.confirmed = toShapeMap(message.canvas.shapes);
        this.pending = [];
        this.savedRevision = message.savedRevision;
        this.saveFailed = false;
        this.cursorMap.clear();
        this.update({
          connection: 'connected',
          room: message.room,
          me: message.participant,
          revision: message.canvas.revision,
          canEdit: message.room.status === 'active',
        });
        return;

      case 'op': {
        // Already reflected in the canvas we hold (e.g. delivered just before a
        // reconnect snapshot): applying it again could overwrite newer state.
        if (message.revision <= this.state.revision) return;
        this.confirmed = applyOp(this.confirmed, message.op);
        if (message.participantId === this.state.me?.id) {
          this.pending = this.pending.filter((p) => p.clientOpId !== message.clientOpId);
          this.watchAcks();
        }
        this.update({ revision: message.revision });
        return;
      }

      case 'op_rejected':
        this.pending = this.pending.filter((p) => p.clientOpId !== message.clientOpId);
        this.watchAcks();
        this.update({ rejection: { code: message.code, message: message.message, at: Date.now() } });
        return;

      case 'cursor':
        if (message.position) {
          this.cursorMap.set(message.participantId, {
            participantId: message.participantId,
            name: message.name,
            color: message.color,
            position: message.position,
          });
        } else {
          this.cursorMap.delete(message.participantId);
        }
        this.refresh();
        return;

      case 'participant_left':
        this.cursorMap.delete(message.participantId);
        this.refresh();
        return;

      case 'participant_joined':
        return;

      case 'saved':
        this.savedRevision = Math.max(this.savedRevision, message.revision);
        this.saveFailed = false;
        this.refresh();
        return;

      case 'save_failed':
        this.saveFailed = true;
        this.refresh();
        return;

      case 'session_ended':
        this.confirmed = toShapeMap(message.canvas.shapes);
        this.pending = [];
        this.savedRevision = message.canvas.revision;
        this.cursorMap.clear();
        this.update({ ended: true, room: message.room, revision: message.canvas.revision, canEdit: false });
        return;

      case 'error':
        this.update({ error: { code: message.code, message: message.message, at: Date.now() } });
        return;
    }
  }

  // ---- state ----------------------------------------------------------------

  private update(patch: Partial<RoomState>): void {
    this.state = { ...this.state, ...patch };
    this.refresh();
  }

  /** Recomputes derived fields and notifies subscribers. */
  private refresh(): void {
    let shapes = this.confirmed;
    for (const p of this.pending) shapes = applyOp(shapes, p.op);
    this.state = {
      ...this.state,
      shapes,
      cursors: [...this.cursorMap.values()],
      save: this.deriveSave(),
    };
    for (const listener of this.listeners) listener();
  }

  /** "Saved" only once the server confirms persistence of everything we've seen. */
  private deriveSave(): SaveState {
    if (this.pending.length > 0) return 'saving';
    if (this.saveFailed) return 'error';
    return this.savedRevision >= this.state.revision ? 'saved' : 'saving';
  }
}

