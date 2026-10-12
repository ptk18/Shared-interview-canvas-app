// In-browser implementation of the backend described in _docs/protocol.md.
// It mirrors the FastAPI room manager: server-ordered ops with revisions,
// two participant slots with a reconnect grace period, debounced snapshots,
// empty-room release and irreversible completion.
import { applyOp, toShapeMap } from '../../canvas/ops';
import type { Canvas, Participant, Room, RoomDetail, ServerMessage, Shape } from '../protocol';
import { CloseCode, MAX_NAME_LENGTH, MAX_PARTICIPANTS, MAX_TITLE_LENGTH, PARTICIPANT_COLORS } from '../protocol';
import { ApiError } from '../types';
import type { RoomStore } from './roomStore';
import { codePointLength, validateOp } from './validation';

/** The server's handle on one client connection. */
export interface ServerConnection {
  send(message: ServerMessage): void;
  close(code: number, reason: string): void;
}

/** What a transport uses to feed one client's traffic into the server. */
export interface ClientHandle {
  receive(data: string): void;
  /**
   * The client went away. `normal` means it closed the socket deliberately
   * (close code 1000); otherwise it dropped or reloaded and keeps a grace period.
   */
  disconnect(normal?: boolean): void;
}

export interface MockServerOptions {
  store: RoomStore;
  saveDebounceMs?: number;
  gracePeriodMs?: number;
  saveRetryMs?: number;
}

type Timer = ReturnType<typeof setTimeout>;

interface Slot {
  participant: Participant;
  token: string;
  conn: ServerConnection | null;
  graceTimer?: Timer;
}

interface LiveRoom {
  room: Room;
  shapes: Map<string, Shape>;
  revision: number;
  savedRevision: number;
  slots: Map<string, Slot>;
  saveTimer?: Timer;
  retryTimer?: Timer;
  saveChain: Promise<unknown>;
  ending: boolean;
}

function randomToken(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const nowIso = () => new Date().toISOString();

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isValidPosition(v: unknown): boolean {
  return (
    v === null ||
    (isPlainObject(v) &&
      Object.keys(v).length === 2 &&
      typeof v.x === 'number' &&
      Number.isFinite(v.x) &&
      typeof v.y === 'number' &&
      Number.isFinite(v.y))
  );
}

export class MockServer {
  private readonly store: RoomStore;
  private readonly saveDebounceMs: number;
  private readonly gracePeriodMs: number;
  private readonly saveRetryMs: number;
  private readonly live = new Map<string, LiveRoom>();
  private readonly loading = new Map<string, Promise<LiveRoom | 'completed' | null>>();

  constructor(options: MockServerOptions) {
    this.store = options.store;
    this.saveDebounceMs = options.saveDebounceMs ?? 500;
    this.gracePeriodMs = options.gracePeriodMs ?? 30_000;
    this.saveRetryMs = options.saveRetryMs ?? 2_000;
  }

  /** Number of rooms held in memory (exposed for tests of empty-room release). */
  get liveRoomCount(): number {
    return this.live.size;
  }

  // ---- REST equivalents -------------------------------------------------

  async createRoom(title: unknown): Promise<Room> {
    const trimmed = typeof title === 'string' ? title.trim() : '';
    if (!trimmed || codePointLength(trimmed) > MAX_TITLE_LENGTH) {
      throw new ApiError(422, 'invalid_title', `Title must be 1–${MAX_TITLE_LENGTH} characters.`);
    }
    const now = nowIso();
    const room: Room = {
      id: randomToken(16),
      title: trimmed,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    await this.store.put({ room, canvas: { revision: 0, shapes: [] } });
    return room;
  }

  async getRoom(roomId: string): Promise<RoomDetail> {
    const live = this.live.get(roomId);
    if (live) return { ...live.room, canvas: this.snapshot(live) };
    const stored = await this.store.get(roomId);
    if (!stored) throw new ApiError(404, 'room_not_found', 'Room not found.');
    return { ...stored.room, canvas: stored.canvas };
  }

  // ---- WebSocket equivalent ----------------------------------------------

  connect(roomId: string, params: { name?: string | null; token?: string | null }, conn: ServerConnection): ClientHandle {
    const joined = this.join(roomId, params, conn).catch(() => {
      conn.close(1011, 'internal error');
      return null;
    });
    return {
      receive: (data) => {
        void joined.then((ctx) => {
          if (ctx && ctx.slot.conn === conn && this.live.get(roomId) === ctx.live) this.handle(ctx.live, ctx.slot, data);
        });
      },
      disconnect: (normal = false) => {
        void joined.then((ctx) => ctx && this.leave(ctx.live, ctx.slot, conn, normal));
      },
    };
  }

  /** Flushes every dirty room (the analogue of the server's shutdown hook). */
  async shutdown(): Promise<void> {
    await Promise.all([...this.live.values()].map((live) => this.flush(live)));
  }

  private async join(
    roomId: string,
    params: { name?: string | null; token?: string | null },
    conn: ServerConnection,
  ): Promise<{ live: LiveRoom; slot: Slot } | null> {
    const fail = (closeCode: number, code: string, message: string) => {
      conn.send({ type: 'error', code, message });
      conn.close(closeCode, code);
      return null;
    };

    const name = (params.name ?? '').trim();
    if (!name || codePointLength(name) > MAX_NAME_LENGTH) {
      return fail(CloseCode.InvalidName, 'invalid_name', `Name must be 1–${MAX_NAME_LENGTH} characters.`);
    }

    const live = await this.loadLive(roomId);
    if (live === null) return fail(CloseCode.RoomNotFound, 'room_not_found', 'Room not found.');
    if (live === 'completed' || live.ending) {
      return fail(CloseCode.RoomCompleted, 'room_completed', 'This session has ended.');
    }

    let slot = params.token ? [...live.slots.values()].find((s) => s.token === params.token) : undefined;
    if (slot) {
      clearTimeout(slot.graceTimer);
      slot.graceTimer = undefined;
      const previous = slot.conn;
      slot.conn = conn;
      if (previous) {
        previous.send({ type: 'error', code: 'replaced', message: 'This seat was taken over by another tab.' });
        previous.close(CloseCode.Replaced, 'replaced');
      }
      slot.participant = { ...slot.participant, name };
      // A takeover of a live connection is invisible to the other participant: nobody left.
      if (previous) {
        conn.send(this.welcome(live, slot));
        return { live, slot };
      }
    } else {
      if (live.slots.size >= MAX_PARTICIPANTS) {
        return fail(CloseCode.RoomFull, 'room_full', 'This room already has two participants.');
      }
      const used = new Set([...live.slots.values()].map((s) => s.participant.color));
      const color = PARTICIPANT_COLORS.find((c) => !used.has(c)) ?? PARTICIPANT_COLORS[0];
      slot = { participant: { id: `p_${randomToken(9)}`, name, color }, token: randomToken(24), conn };
      live.slots.set(slot.participant.id, slot);
    }

    conn.send(this.welcome(live, slot));
    this.broadcast(live, { type: 'participant_joined', participant: slot.participant }, slot);
    return { live, slot };
  }

  private welcome(live: LiveRoom, slot: Slot): ServerMessage {
    return {
      type: 'welcome',
      participant: slot.participant,
      token: slot.token,
      room: live.room,
      canvas: this.snapshot(live),
      savedRevision: live.savedRevision,
      participants: [...live.slots.values()].filter((s) => s !== slot && s.conn).map((s) => s.participant),
    };
  }

  private loadLive(roomId: string): Promise<LiveRoom | 'completed' | null> {
    const existing = this.live.get(roomId);
    if (existing) return Promise.resolve(existing);
    let pending = this.loading.get(roomId);
    if (!pending) {
      pending = this.store
        .get(roomId)
        .then((stored): LiveRoom | 'completed' | null => {
          if (!stored) return null;
          if (stored.room.status === 'completed') return 'completed';
          const live: LiveRoom = {
            room: stored.room,
            shapes: toShapeMap(stored.canvas.shapes),
            revision: stored.canvas.revision,
            savedRevision: stored.canvas.revision,
            slots: new Map(),
            saveChain: Promise.resolve(),
            ending: false,
          };
          this.live.set(roomId, live);
          return live;
        })
        .finally(() => this.loading.delete(roomId));
      this.loading.set(roomId, pending);
    }
    return pending;
  }

  private handle(live: LiveRoom, slot: Slot, data: string): void {
    const conn = slot.conn!;
    const invalid = (message: string) => conn.send({ type: 'error', code: 'invalid_message', message });
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return invalid('Message is not valid JSON.');
    }
    if (!isPlainObject(msg)) return invalid('Message must be an object.');

    switch (msg.type) {
      case 'op': {
        const { clientOpId } = msg;
        if (typeof clientOpId !== 'string' || clientOpId.length < 1 || clientOpId.length > 64 || !('op' in msg)) {
          return invalid('An op message needs a clientOpId and an op.');
        }
        if (live.ending || live.room.status === 'completed') {
          conn.send({ type: 'op_rejected', clientOpId, code: 'room_completed', message: 'This session has ended.' });
          return;
        }
        const result = validateOp(live.shapes, msg.op);
        if (!result.ok) {
          conn.send({ type: 'op_rejected', clientOpId, code: result.code, message: result.message });
          return;
        }
        live.shapes = applyOp(live.shapes, result.op);
        live.revision += 1;
        live.room = { ...live.room, updatedAt: nowIso() };
        this.broadcast(live, {
          type: 'op',
          revision: live.revision,
          op: result.op,
          participantId: slot.participant.id,
          clientOpId,
        });
        this.scheduleSave(live);
        return;
      }
      case 'cursor': {
        if (!isValidPosition(msg.position)) return invalid('Cursor position must be {x, y} or null.');
        const position = msg.position as { x: number; y: number } | null;
        this.broadcast(
          live,
          {
            type: 'cursor',
            participantId: slot.participant.id,
            name: slot.participant.name,
            color: slot.participant.color,
            position: position && { x: position.x, y: position.y },
          },
          slot,
        );
        return;
      }
      case 'end_session':
        void this.endSession(live, slot);
        return;
      default:
        return invalid('Unknown message type.');
    }
  }

  private leave(live: LiveRoom, slot: Slot, conn: ServerConnection, normal: boolean): void {
    if (slot.conn !== conn) return; // replaced by a newer connection, or already gone
    slot.conn = null;
    this.broadcast(live, { type: 'participant_left', participantId: slot.participant.id }, slot);
    const release = () => {
      if (slot.conn) return;
      live.slots.delete(slot.participant.id);
      void this.maybeRelease(live);
    };
    // Leaving on purpose frees the seat at once; a drop keeps it for the grace period.
    if (normal) release();
    else slot.graceTimer = setTimeout(release, this.gracePeriodMs);
  }

  private async endSession(live: LiveRoom, requester: Slot): Promise<void> {
    if (live.ending) return;
    live.ending = true;
    const failed = () => {
      live.ending = false;
      requester.conn?.send({ type: 'error', code: 'save_failed', message: 'Could not save the final canvas.' });
      // Everyone may have left while we were trying.
      void this.maybeRelease(live);
    };
    if (!(await this.flush(live))) return failed();
    const now = nowIso();
    const room: Room = { ...live.room, status: 'completed', completedAt: now, updatedAt: now };
    const canvas = this.snapshot(live);
    try {
      await this.store.put({ room, canvas });
    } catch {
      return failed();
    }
    live.room = room;
    for (const slot of live.slots.values()) {
      clearTimeout(slot.graceTimer);
      if (!slot.conn) continue;
      slot.conn.send({ type: 'session_ended', room, canvas });
      slot.conn.close(CloseCode.RoomCompleted, 'room_completed');
      slot.conn = null;
    }
    this.dispose(live);
  }

  // ---- persistence ---------------------------------------------------------

  private snapshot(live: LiveRoom): Canvas {
    return { revision: live.revision, shapes: structuredClone([...live.shapes.values()]) };
  }

  private scheduleSave(live: LiveRoom): void {
    clearTimeout(live.saveTimer);
    live.saveTimer = setTimeout(() => {
      live.saveTimer = undefined;
      void this.persist(live);
    }, this.saveDebounceMs);
  }

  /** Writes the current snapshot. Writes are chained so they land in order. Resolves true on success. */
  private persist(live: LiveRoom): Promise<boolean> {
    const write = async (): Promise<boolean> => {
      if (live.revision <= live.savedRevision) return true;
      const canvas = this.snapshot(live);
      const room = live.room;
      try {
        const existing = await this.store.get(room.id);
        // Never replace a newer snapshot with an older one, and never reopen a completed room.
        const writable = !existing || (existing.room.status === 'active' && existing.canvas.revision <= canvas.revision);
        if (writable) await this.store.put({ room, canvas });
      } catch (error) {
        this.broadcast(live, {
          type: 'save_failed',
          message: error instanceof Error ? error.message : 'Snapshot write failed.',
        });
        this.scheduleRetry(live);
        return false;
      }
      live.savedRevision = Math.max(live.savedRevision, canvas.revision);
      this.broadcast(live, { type: 'saved', revision: live.savedRevision });
      if (live.slots.size === 0) void this.maybeRelease(live);
      return true;
    };
    const result = live.saveChain.then(write);
    live.saveChain = result.catch(() => false);
    return result;
  }

  private scheduleRetry(live: LiveRoom): void {
    if (live.retryTimer) return;
    live.retryTimer = setTimeout(() => {
      live.retryTimer = undefined;
      if (live.revision > live.savedRevision) void this.persist(live);
    }, this.saveRetryMs);
  }

  /** Writes any pending changes now. Resolves true when everything is persisted. */
  private async flush(live: LiveRoom): Promise<boolean> {
    clearTimeout(live.saveTimer);
    live.saveTimer = undefined;
    await live.saveChain;
    return live.revision <= live.savedRevision || this.persist(live);
  }

  private async maybeRelease(live: LiveRoom): Promise<void> {
    // An ending session releases itself once completion is written.
    if (live.ending || live.slots.size > 0 || this.live.get(live.room.id) !== live) return;
    const clean = await this.flush(live);
    // A failed flush leaves the retry timer armed; the successful retry calls back here.
    if (clean && live.slots.size === 0 && this.live.get(live.room.id) === live) this.dispose(live);
  }

  private dispose(live: LiveRoom): void {
    clearTimeout(live.saveTimer);
    clearTimeout(live.retryTimer);
    for (const slot of live.slots.values()) clearTimeout(slot.graceTimer);
    if (this.live.get(live.room.id) === live) this.live.delete(live.room.id);
  }

  private broadcast(live: LiveRoom, message: ServerMessage, except?: Slot): void {
    for (const slot of live.slots.values()) {
      if (slot !== except && slot.conn) slot.conn.send(message);
    }
  }
}
