import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../../test/mockHarness';
import type { BoxShape, ClientMessage, ServerMessage } from '../protocol';
import { ApiError, type BackendService } from '../types';
import type { RoomStore, StoredRoom } from './roomStore';

type Msg<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

interface Recorder {
  messages: ServerMessage[];
  closed: { code: number; reason: string } | null;
  send(message: ClientMessage): void;
  close(): void;
  next<T extends ServerMessage['type']>(type: T, from?: number): Promise<Msg<T>>;
  welcome(): Promise<Msg<'welcome'>>;
  waitClosed(): Promise<{ code: number; reason: string }>;
}

function join(backend: BackendService, roomId: string, name: string, token?: string | null): Recorder {
  const rec: Recorder = {
    messages: [],
    closed: null,
    send: (m) => socket.send(m),
    close: () => socket.close(),
    async next(type, from = 0) {
      return vi.waitFor(() => {
        const found = rec.messages.slice(from).find((m) => m.type === type);
        if (!found) throw new Error(`no ${type} yet`);
        return found as never;
      });
    },
    welcome: () => rec.next('welcome'),
    waitClosed: () =>
      vi.waitFor(() => {
        if (!rec.closed) throw new Error('still open');
        return rec.closed;
      }),
  };
  const socket = backend.connectRoom(roomId, { name, token }, {
    onOpen: () => {},
    onMessage: (m) => rec.messages.push(m),
    onClose: (e) => (rec.closed = e),
  });
  return rec;
}

const rect = (id: string, x = 0): BoxShape => ({
  id,
  type: 'rect',
  x,
  y: 0,
  width: 100,
  height: 50,
  fill: '#ffffff',
  stroke: '#1f2328',
  label: '',
  textColor: '#1f2328',
});

let h: Harness;
afterEach(() => h?.close());

describe('mock server — REST equivalents', () => {
  it('creates a room with an unguessable id and a trimmed title', async () => {
    h = createHarness();
    const api = h.client();
    const room = await api.createRoom('  Design a URL Shortener  ');
    expect(room).toMatchObject({ title: 'Design a URL Shortener', status: 'active', completedAt: null });
    expect(room.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const detail = await api.getRoom(room.id);
    expect(detail.canvas).toEqual({ revision: 0, shapes: [] });
  });

  it.each([[''], ['   '], ['x'.repeat(121)]])('rejects title %j with invalid_title', async (title) => {
    h = createHarness();
    await expect(h.client().createRoom(title)).rejects.toMatchObject({ status: 422, code: 'invalid_title' });
  });

  it('reports unknown rooms as room_not_found', async () => {
    h = createHarness();
    const error = await h.client().getRoom('nope').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, code: 'room_not_found' });
  });
});

describe('mock server — collaboration', () => {
  it('broadcasts accepted ops with increasing revisions and echoes clientOpId to the sender', async () => {
    h = createHarness();
    const room = await h.client().createRoom('t');
    const a = join(h.client(), room.id, 'Ada');
    const b = join(h.client(), room.id, 'Bo');
    const wa = await a.welcome();
    await b.welcome();

    a.send({ type: 'op', clientOpId: 'c1', op: { kind: 'create', shape: rect('r1') } });
    b.send({ type: 'op', clientOpId: 'c2', op: { kind: 'update', id: 'r1', patch: { x: 40 } } });

    const opsSeenByB = await vi.waitFor(() => {
      const ops = b.messages.filter((m): m is Msg<'op'> => m.type === 'op');
      if (ops.length < 2) throw new Error('waiting');
      return ops;
    });
    expect(opsSeenByB.map((o) => o.revision)).toEqual([1, 2]);
    const echo = await a.next('op');
    expect(echo).toMatchObject({ clientOpId: 'c1', participantId: wa.participant.id, revision: 1 });
    expect((await h.client().getRoom(room.id)).canvas.shapes).toEqual([{ ...rect('r1'), x: 40 }]);
  });

  it('sends op_rejected only to the sender', async () => {
    h = createHarness();
    const room = await h.client().createRoom('t');
    const a = join(h.client(), room.id, 'Ada');
    const b = join(h.client(), room.id, 'Bo');
    await a.welcome();
    await b.welcome();
    a.send({ type: 'op', clientOpId: 'bad', op: { kind: 'delete', id: 'ghost' } });
    expect(await a.next('op_rejected')).toMatchObject({ clientOpId: 'bad', code: 'shape_not_found' });
    // A later cursor from A reaches B; the rejection never did.
    a.send({ type: 'cursor', position: { x: 1, y: 2 } });
    await b.next('cursor');
    expect(b.messages.some((m) => m.type === 'op_rejected')).toBe(false);
  });

  it('applies concurrent edits to one shape last-write-wins in server order', async () => {
    h = createHarness();
    const room = await h.client().createRoom('t');
    const a = join(h.client(), room.id, 'Ada');
    const b = join(h.client(), room.id, 'Bo');
    await a.welcome();
    await b.welcome();
    a.send({ type: 'op', clientOpId: 'c', op: { kind: 'create', shape: rect('r1') } });
    await b.next('op');
    a.send({ type: 'op', clientOpId: 'a1', op: { kind: 'update', id: 'r1', patch: { fill: '#ff0000', x: 5 } } });
    b.send({ type: 'op', clientOpId: 'b1', op: { kind: 'update', id: 'r1', patch: { fill: '#00ff00' } } });
    const ops = await vi.waitFor(() => {
      const list = a.messages.filter((m): m is Msg<'op'> => m.type === 'op');
      if (list.length < 3) throw new Error('waiting');
      return list;
    });
    const last = ops[2]!;
    const canvas = (await h.client().getRoom(room.id)).canvas;
    const shape = canvas.shapes[0] as BoxShape;
    // Fields from both patches survive; the colour is whichever patch the server applied last.
    expect(shape.x).toBe(5);
    expect(shape.fill).toBe(last.clientOpId === 'a1' ? '#ff0000' : '#00ff00');
    expect(canvas.revision).toBe(3);
  });

  it('relays cursors to the other participant only and never persists them', async () => {
    h = createHarness();
    const room = await h.client().createRoom('t');
    const a = join(h.client(), room.id, 'Ada');
    const b = join(h.client(), room.id, 'Bo');
    const wa = await a.welcome();
    await b.welcome();
    a.send({ type: 'cursor', position: { x: 10, y: 20 } });
    expect(await b.next('cursor')).toEqual({
      type: 'cursor',
      participantId: wa.participant.id,
      name: 'Ada',
      color: wa.participant.color,
      position: { x: 10, y: 20 },
    });
    expect(a.messages.some((m) => m.type === 'cursor')).toBe(false);
    expect((await h.client().getRoom(room.id)).canvas.revision).toBe(0);
  });

  it('answers malformed messages with invalid_message and keeps the connection open', async () => {
    h = createHarness();
    const room = await h.client().createRoom('t');
    const a = join(h.client(), room.id, 'Ada');
    await a.welcome();
    a.send({ type: 'op', op: { kind: 'delete', id: 'x' } } as unknown as ClientMessage);
    a.send({ type: 'cursor', position: { x: 'left', y: 0 } } as unknown as ClientMessage);
    a.send({ type: 'dance' } as unknown as ClientMessage);
    await vi.waitFor(() => {
      const errors = a.messages.filter((m) => m.type === 'error' && m.code === 'invalid_message');
      if (errors.length < 3) throw new Error('waiting');
    });
    a.send({ type: 'op', clientOpId: 'ok', op: { kind: 'create', shape: rect('r1') } });
    await a.next('op');
    expect(a.closed).toBeNull();
  });
});

describe('mock server — participants and reconnection', () => {
  it('assigns distinct colours and refuses a third participant with room_full (4003)', async () => {
    h = createHarness();
    const room = await h.client().createRoom('t');
    const a = await join(h.client(), room.id, 'Ada').welcome();
    const b = await join(h.client(), room.id, 'Bo').welcome();
    expect(a.participant.color).not.toBe(b.participant.color);
    expect(b.participants).toEqual([a.participant]);
    const c = join(h.client(), room.id, 'Cy');
    expect(await c.next('error')).toMatchObject({ code: 'room_full' });
    expect(await c.waitClosed()).toMatchObject({ code: 4003 });
  });

  it.each([
    ['', 4000, 'invalid_name'],
    ['x'.repeat(41), 4000, 'invalid_name'],
  ])('rejects name %j', async (name, code, errorCode) => {
    h = createHarness();
    const room = await h.client().createRoom('t');
    const rec = join(h.client(), room.id, name);
    expect(await rec.next('error')).toMatchObject({ code: errorCode });
    expect(await rec.waitClosed()).toMatchObject({ code });
  });

  it('closes unknown rooms with 4004', async () => {
    h = createHarness();
    const rec = join(h.client(), 'missing', 'Ada');
    expect(await rec.waitClosed()).toMatchObject({ code: 4004 });
  });

  it('lets a dropped participant reclaim their slot with their token during the grace period', async () => {
    h = createHarness({ gracePeriodMs: 2_000 });
    const room = await h.client().createRoom('t');
    const tab = h.client();
    const a = join(tab, room.id, 'Ada');
    const wa = await a.welcome();
    const b = join(h.client(), room.id, 'Bo');
    await b.welcome();
    b.send({ type: 'op', clientOpId: 'c', op: { kind: 'create', shape: rect('r1') } });
    await a.next('op');

    tab.simulateNetworkDrop!();
    expect(await a.waitClosed()).toMatchObject({ code: 1006 });
    await b.next('participant_left');

    // While A is away the slot stays reserved: a newcomer is refused.
    const c = join(h.client(), room.id, 'Cy');
    expect(await c.waitClosed()).toMatchObject({ code: 4003 });

    const back = await join(tab, room.id, 'Ada L.', wa.token).welcome();
    expect(back.participant).toEqual({ ...wa.participant, name: 'Ada L.' });
    expect(back.token).toBe(wa.token);
    expect(back.canvas.shapes.map((s) => s.id)).toEqual(['r1']);
  });

  it('releases the slot once the grace period expires', async () => {
    h = createHarness({ gracePeriodMs: 400 });
    const room = await h.client().createRoom('t');
    const tab = h.client();
    const a = join(tab, room.id, 'Ada');
    const wa = await a.welcome();
    const b = join(h.client(), room.id, 'Bo');
    await b.welcome();
    tab.simulateNetworkDrop!();
    await b.next('participant_left');
    // Still reserved inside the grace period...
    expect(await join(h.client(), room.id, 'Early').waitClosed()).toMatchObject({ code: 4003 });
    await new Promise((r) => setTimeout(r, 500));
    const c = await join(h.client(), room.id, 'Cy').welcome();
    expect(c.participant.id).not.toBe(wa.participant.id);
    // The expired token no longer reclaims anything — and the room is now full.
    const late = join(h.client(), room.id, 'Ada', wa.token);
    expect(await late.waitClosed()).toMatchObject({ code: 4003 });
  });

  it('frees the seat at once when a participant leaves on purpose (close code 1000)', async () => {
    h = createHarness({ gracePeriodMs: 60_000 });
    const room = await h.client().createRoom('t');
    const a = join(h.client(), room.id, 'Ada');
    const wa = await a.welcome();
    const b = join(h.client(), room.id, 'Bo');
    await b.welcome();
    a.close();
    expect(await b.next('participant_left')).toMatchObject({ participantId: wa.participant.id });
    const c = await join(h.client(), room.id, 'Cy').welcome();
    expect(c.participant.color).toBe(wa.participant.color);
  });

  it('hands the slot to a refreshed tab and closes the stale connection with 4001', async () => {
    h = createHarness();
    const room = await h.client().createRoom('t');
    const other = join(h.client(), room.id, 'Bo');
    await other.welcome();
    const old = join(h.client(), room.id, 'Ada');
    const w = await old.welcome();
    await other.next('participant_joined');
    const fresh = await join(h.client(), room.id, 'Ada', w.token).welcome();
    expect(fresh.participant.id).toBe(w.participant.id);
    expect(await old.next('error')).toMatchObject({ code: 'replaced' });
    expect(await old.waitClosed()).toMatchObject({ code: 4001 });
    // Nobody left, so the other participant hears nothing (matches FastAPI).
    expect(other.messages.filter((m) => m.type === 'participant_joined')).toHaveLength(1);
    expect(other.messages.some((m) => m.type === 'participant_left')).toBe(false);
  });

  it('keeps the seat when a client abandons a dead connection to reconnect', async () => {
    h = createHarness({ gracePeriodMs: 60_000 });
    const room = await h.client().createRoom('t');
    const backend = h.client();
    const a = join(backend, room.id, 'Ada');
    const wa = await a.welcome();
    await join(h.client(), room.id, 'Bo').welcome();
    const socket = backend.connectRoom(room.id, { name: 'Ada', token: wa.token }, { onOpen() {}, onMessage() {}, onClose() {} });
    await a.waitClosed(); // replaced
    socket.close({ reconnecting: true });
    expect(await join(h.client(), room.id, 'Cy').waitClosed()).toMatchObject({ code: 4003 });
    expect((await join(h.client(), room.id, 'Ada', wa.token).welcome()).participant.id).toBe(wa.participant.id);
  });
});

describe('mock server — persistence', () => {
  it('debounces snapshot writes and reports the saved revision', async () => {
    h = createHarness({ saveDebounceMs: 60 });
    const room = await h.client().createRoom('t');
    const a = join(h.client(), room.id, 'Ada');
    await a.welcome();
    const put = vi.spyOn(h.store, 'put');
    for (let i = 1; i <= 3; i++) a.send({ type: 'op', clientOpId: `c${i}`, op: { kind: 'create', shape: rect(`r${i}`) } });
    expect(await a.next('saved')).toEqual({ type: 'saved', revision: 3 });
    expect(put).toHaveBeenCalledTimes(1);
    expect((await h.store.get(room.id))!.canvas.revision).toBe(3);
  });

  it('broadcasts save_failed, keeps the room dirty and retries', async () => {
    const backing = new Map<string, StoredRoom>();
    let failNext = 0;
    const flaky: RoomStore = {
      get: async (id) => structuredClone(backing.get(id)),
      put: async (r) => {
        if (failNext > 0) {
          failNext -= 1;
          throw new Error('disk full');
        }
        backing.set(r.room.id, structuredClone(r));
      },
    };
    h = createHarness({ store: flaky });
    const room = await h.client().createRoom('t');
    const a = join(h.client(), room.id, 'Ada');
    await a.welcome();
    failNext = 1;
    a.send({ type: 'op', clientOpId: 'c1', op: { kind: 'create', shape: rect('r1') } });
    expect(await a.next('save_failed')).toMatchObject({ message: 'disk full' });
    expect(await a.next('saved')).toEqual({ type: 'saved', revision: 1 });
    expect(backing.get(room.id)!.canvas.shapes).toHaveLength(1);
  });

  it('releases an empty room from memory after flushing, without completing it', async () => {
    h = createHarness({ gracePeriodMs: 30, saveDebounceMs: 10_000 });
    const room = await h.client().createRoom('t');
    const a = join(h.client(), room.id, 'Ada');
    await a.welcome();
    a.send({ type: 'op', clientOpId: 'c1', op: { kind: 'create', shape: rect('r1') } });
    await a.next('op');
    expect(h.server.liveRoomCount).toBe(1);
    a.close();
    // The 10 s debounce never fires; the release path must flush on its own.
    await vi.waitFor(() => expect(h.server.liveRoomCount).toBe(0));
    const stored = (await h.store.get(room.id))!;
    expect(stored.room.status).toBe('active');
    expect(stored.canvas.shapes.map((s) => s.id)).toEqual(['r1']);
  });

  it('serves a restarted server from the stored snapshot', async () => {
    h = createHarness();
    const room = await h.client().createRoom('t');
    const a = join(h.client(), room.id, 'Ada');
    await a.welcome();
    a.send({ type: 'op', clientOpId: 'c1', op: { kind: 'create', shape: rect('r1', 7) } });
    await a.next('saved');
    const restarted = createHarness({ store: h.store });
    try {
      const w = await join(restarted.client(), room.id, 'Ada').welcome();
      expect(w.canvas).toEqual({ revision: 1, shapes: [rect('r1', 7)] });
      expect(w.savedRevision).toBe(1);
    } finally {
      restarted.close();
    }
  });
});

describe('mock server — ending a session', () => {
  it('stays completed even if both participants leave while it is ending', async () => {
    h = createHarness({ saveDebounceMs: 10_000, gracePeriodMs: 10 });
    const room = await h.client().createRoom('t');
    const a = join(h.client(), room.id, 'Ada');
    await a.welcome();
    a.send({ type: 'op', clientOpId: 'c1', op: { kind: 'create', shape: rect('r1') } });
    await a.next('op');
    a.send({ type: 'end_session' });
    a.close();
    await vi.waitFor(async () => expect((await h.store.get(room.id))!.room.status).toBe('completed'));
    const late = join(h.client(), room.id, 'Cy');
    expect(await late.waitClosed()).toMatchObject({ code: 4009 });
    await new Promise((r) => setTimeout(r, 50));
    expect((await h.store.get(room.id))!.room.status).toBe('completed');
  });

  it('flushes, completes, notifies both participants and refuses later joins', async () => {
    h = createHarness({ saveDebounceMs: 10_000 });
    const room = await h.client().createRoom('t');
    const a = join(h.client(), room.id, 'Ada');
    const b = join(h.client(), room.id, 'Bo');
    await a.welcome();
    await b.welcome();
    a.send({ type: 'op', clientOpId: 'c1', op: { kind: 'create', shape: rect('r1') } });
    await b.next('op');
    b.send({ type: 'end_session' });

    for (const rec of [a, b]) {
      const ended = await rec.next('session_ended');
      expect(ended.room.status).toBe('completed');
      expect(ended.room.completedAt).toEqual(expect.any(String));
      expect(ended.canvas.shapes.map((s) => s.id)).toEqual(['r1']);
      expect(await rec.waitClosed()).toMatchObject({ code: 4009 });
    }

    const detail = await h.client().getRoom(room.id);
    expect(detail.status).toBe('completed');
    expect(detail.canvas.shapes).toHaveLength(1);
    const late = join(h.client(), room.id, 'Cy');
    expect(await late.next('error')).toMatchObject({ code: 'room_completed' });
    expect(await late.waitClosed()).toMatchObject({ code: 4009 });
  });
});
