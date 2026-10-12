import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoxShape, Canvas, Room, ServerMessage } from '../services/protocol';
import { FakeBackend } from '../test/fakeBackend';
import { createHarness, type Harness } from '../test/mockHarness';
import { RoomSession, type TokenStore } from './roomSession';

const room: Room = {
  id: 'room1',
  title: 'URL shortener',
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  completedAt: null,
};
const me = { id: 'p_me', name: 'Ada', color: '#e8590c' };
const other = { id: 'p_other', name: 'Bo', color: '#1c7ed6' };

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

function welcome(canvas: Canvas = { revision: 0, shapes: [] }, savedRevision = canvas.revision): ServerMessage {
  return { type: 'welcome', participant: me, token: 'tok-1', room, canvas, savedRevision, participants: [] };
}

function memoryTokens(): TokenStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, get: (id) => values.get(id) ?? null, set: (id, t) => void values.set(id, t) };
}

function setup(delays = [100, 200]) {
  const backend = new FakeBackend();
  const tokens = memoryTokens();
  const session = new RoomSession({ backend, roomId: 'room1', name: 'Ada', tokens, reconnectDelaysMs: delays });
  session.start();
  return { backend, tokens, session };
}

const ids = (session: RoomSession) => [...session.getState().shapes.keys()];
const lastSentOp = (backend: FakeBackend) => {
  const op = backend.last.sent.filter((m) => m.type === 'op').at(-1);
  if (!op || op.type !== 'op') throw new Error('no op sent');
  return op;
};

describe('RoomSession — joining and editing', () => {
  it('is not editable until the server welcomes it, then loads the authoritative canvas', () => {
    const { backend, tokens, session } = setup();
    expect(session.getState()).toMatchObject({ connection: 'connecting', canEdit: false });
    expect(session.apply({ kind: 'create', shape: rect('r0') })).toBe(false);
    expect(backend.last.sent).toEqual([]);

    backend.last.emit(welcome({ revision: 4, shapes: [rect('r1')] }));
    expect(session.getState()).toMatchObject({ connection: 'connected', canEdit: true, revision: 4, me, save: 'saved' });
    expect(ids(session)).toEqual(['r1']);
    expect(tokens.values.get('room1')).toBe('tok-1');
  });

  it('shows local edits immediately and reports Saved only after the server persisted them', () => {
    const { backend, session } = setup();
    backend.last.emit(welcome());
    session.apply({ kind: 'create', shape: rect('r1') });
    expect(ids(session)).toEqual(['r1']);
    expect(session.getState().save).toBe('saving');

    const sent = lastSentOp(backend);
    backend.last.emit({ type: 'op', revision: 1, op: sent.op, participantId: me.id, clientOpId: sent.clientOpId });
    expect(session.getState()).toMatchObject({ revision: 1, save: 'saving' });
    backend.last.emit({ type: 'saved', revision: 1 });
    expect(session.getState().save).toBe('saved');
  });

  it('ignores ops at or below the revision it already holds', () => {
    const { backend, session } = setup();
    backend.last.emit(welcome({ revision: 5, shapes: [rect('r1', 50)] }));
    backend.last.emit({
      type: 'op',
      revision: 5,
      op: { kind: 'update', id: 'r1', patch: { x: 1 } },
      participantId: other.id,
      clientOpId: 'x',
    });
    expect((session.getState().shapes.get('r1') as BoxShape).x).toBe(50);
    backend.last.emit({
      type: 'op',
      revision: 6,
      op: { kind: 'update', id: 'r1', patch: { x: 2 } },
      participantId: other.id,
      clientOpId: 'x',
    });
    expect((session.getState().shapes.get('r1') as BoxShape).x).toBe(2);
  });

  it('lets a server-ordered remote edit win over an earlier local one (last write wins)', () => {
    const { backend, session } = setup();
    backend.last.emit(welcome({ revision: 1, shapes: [rect('r1')] }));
    session.apply({ kind: 'update', id: 'r1', patch: { fill: '#ff0000' } });
    const mine = lastSentOp(backend);
    // Server applied ours first (rev 2), then theirs (rev 3).
    backend.last.emit({ type: 'op', revision: 2, op: mine.op, participantId: me.id, clientOpId: mine.clientOpId });
    backend.last.emit({
      type: 'op',
      revision: 3,
      op: { kind: 'update', id: 'r1', patch: { fill: '#00ff00' } },
      participantId: other.id,
      clientOpId: mine.clientOpId, // same id from another client must not clear our state
    });
    expect((session.getState().shapes.get('r1') as BoxShape).fill).toBe('#00ff00');
  });

  it('keeps an unconfirmed local edit on top of remote changes until the server orders it', () => {
    const { backend, session } = setup();
    backend.last.emit(welcome({ revision: 1, shapes: [rect('r1')] }));
    session.apply({ kind: 'update', id: 'r1', patch: { x: 30 } });
    backend.last.emit({
      type: 'op',
      revision: 2,
      op: { kind: 'update', id: 'r1', patch: { x: 99, fill: '#000000' } },
      participantId: other.id,
      clientOpId: 'theirs',
    });
    expect(session.getState().shapes.get('r1')).toMatchObject({ x: 30, fill: '#000000' });
  });

  it('rolls back a rejected op and surfaces the reason', () => {
    const { backend, session } = setup();
    backend.last.emit(welcome({ revision: 1, shapes: [rect('r1')] }));
    session.apply({ kind: 'delete', id: 'r1' });
    expect(ids(session)).toEqual([]);
    const sent = lastSentOp(backend);
    backend.last.emit({ type: 'op_rejected', clientOpId: sent.clientOpId, code: 'shape_not_found', message: 'gone' });
    expect(ids(session)).toEqual(['r1']);
    expect(session.getState().rejection).toMatchObject({ code: 'shape_not_found' });
    expect(session.getState().save).toBe('saved');
  });

  it('shows a save failure until a later save succeeds', () => {
    const { backend, session } = setup();
    backend.last.emit(welcome({ revision: 2, shapes: [] }, 1));
    expect(session.getState().save).toBe('saving');
    backend.last.emit({ type: 'save_failed', message: 'disk full' });
    expect(session.getState().save).toBe('error');
    backend.last.emit({ type: 'saved', revision: 2 });
    expect(session.getState().save).toBe('saved');
  });
});

describe('RoomSession — cursors', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('throttles outgoing cursor updates to one per 50 ms, keeping the latest position', () => {
    const { backend, session } = setup();
    backend.last.emit(welcome());
    for (let x = 1; x <= 5; x++) session.sendCursor({ x, y: 0 });
    vi.advanceTimersByTime(60);
    const cursors = backend.last.sent.filter((m) => m.type === 'cursor');
    expect(cursors).toEqual([
      { type: 'cursor', position: { x: 1, y: 0 } },
      { type: 'cursor', position: { x: 5, y: 0 } },
    ]);
  });

  it('tracks remote cursors and drops them when the participant leaves', () => {
    const { backend, session } = setup();
    backend.last.emit(welcome());
    backend.last.emit({ type: 'cursor', participantId: other.id, name: 'Bo', color: other.color, position: { x: 3, y: 4 } });
    expect(session.getState().cursors).toEqual([
      { participantId: other.id, name: 'Bo', color: other.color, position: { x: 3, y: 4 } },
    ]);
    backend.last.emit({ type: 'participant_left', participantId: other.id });
    expect(session.getState().cursors).toEqual([]);
  });
});

describe('RoomSession — interruptions', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('disables editing on a drop, drops unconfirmed edits, and reconnects with its token', () => {
    const { backend, session } = setup();
    backend.last.emit(welcome({ revision: 1, shapes: [rect('r1')] }));
    session.apply({ kind: 'create', shape: rect('local') });
    backend.last.drop(1006);

    expect(session.getState()).toMatchObject({ connection: 'reconnecting', canEdit: false });
    expect(ids(session)).toEqual(['r1']);
    expect(session.apply({ kind: 'delete', id: 'r1' })).toBe(false);

    vi.advanceTimersByTime(100);
    expect(backend.connections).toHaveLength(2);
    expect(backend.last.params).toEqual({ name: 'Ada', token: 'tok-1' });
    backend.last.emit(welcome({ revision: 9, shapes: [rect('r1', 40), rect('r2')] }));
    expect(session.getState()).toMatchObject({ connection: 'connected', canEdit: true, revision: 9 });
    expect(ids(session)).toEqual(['r1', 'r2']);
  });

  it('gives up after its reconnect schedule and can be retried manually', () => {
    const { backend, session } = setup([100, 200]);
    backend.last.emit(welcome());
    backend.last.drop();
    vi.advanceTimersByTime(100);
    backend.last.drop();
    vi.advanceTimersByTime(200);
    backend.last.drop();
    expect(session.getState().connection).toBe('disconnected');
    vi.advanceTimersByTime(10_000);
    expect(backend.connections).toHaveLength(3);

    session.retry();
    expect(backend.connections).toHaveLength(4);
    backend.last.emit(welcome());
    expect(session.getState().connection).toBe('connected');
  });

  it.each([
    [4003, 'room_full'],
    [4004, 'room_not_found'],
    [4009, 'room_completed'],
    [4001, 'replaced'],
    [4000, 'invalid_name'],
  ] as const)('does not reconnect after close code %i (%s)', (code, fatal) => {
    const { backend, session } = setup();
    backend.last.drop(code);
    vi.advanceTimersByTime(10_000);
    expect(backend.connections).toHaveLength(1);
    expect(session.getState()).toMatchObject({ connection: 'disconnected', fatal });
  });

  it('becomes read-only with the final canvas when the session ends', () => {
    const { backend, session } = setup();
    backend.last.emit(welcome());
    const done = { ...room, status: 'completed' as const, completedAt: '2026-01-01T01:00:00Z' };
    backend.last.emit({ type: 'session_ended', room: done, canvas: { revision: 3, shapes: [rect('final')] } });
    backend.last.drop(4009);
    expect(session.getState()).toMatchObject({ ended: true, canEdit: false, fatal: null, room: done });
    expect(ids(session)).toEqual(['final']);
    expect(session.apply({ kind: 'delete', id: 'final' })).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(backend.connections).toHaveLength(1);
  });

  it('abandons a silently dead connection when an edit goes unacknowledged, keeping its seat', () => {
    const { backend, session } = setup();
    backend.last.emit(welcome({ revision: 1, shapes: [rect('r1')] }));
    session.apply({ kind: 'update', id: 'r1', patch: { x: 5 } });
    vi.advanceTimersByTime(7_999);
    expect(session.getState().connection).toBe('connected');
    vi.advanceTimersByTime(1);
    expect(session.getState()).toMatchObject({ connection: 'reconnecting', canEdit: false });
    expect(backend.connections[0]!.closeOptions).toEqual({ reconnecting: true });
    vi.advanceTimersByTime(100);
    expect(backend.connections).toHaveLength(2);
  });

  it('keeps a healthy connection whose edits are acknowledged', () => {
    const { backend, session } = setup();
    backend.last.emit(welcome({ revision: 1, shapes: [rect('r1')] }));
    for (let i = 0; i < 5; i++) {
      session.apply({ kind: 'update', id: 'r1', patch: { x: i } });
      const sent = lastSentOp(backend);
      vi.advanceTimersByTime(5_000);
      backend.last.emit({ type: 'op', revision: 2 + i, op: sent.op, participantId: me.id, clientOpId: sent.clientOpId });
    }
    vi.advanceTimersByTime(20_000);
    expect(session.getState().connection).toBe('connected');
    expect(backend.connections).toHaveLength(1);
  });

  it('stops everything on dispose', () => {
    const { backend, session } = setup();
    backend.last.emit(welcome());
    backend.last.drop();
    session.dispose();
    vi.advanceTimersByTime(10_000);
    expect(backend.connections).toHaveLength(1);
  });
});

describe('RoomSession — against the mock server', () => {
  let h: Harness;
  afterEach(() => h.close());

  function join(backendIndex: number, name: string, reconnectDelaysMs = [20, 20, 20]) {
    const backend = clients[backendIndex]!;
    const s = new RoomSession({ backend, roomId, name, tokens: memoryTokens(), reconnectDelaysMs });
    s.start();
    return s;
  }
  let clients: ReturnType<Harness['client']>[];
  let roomId: string;

  beforeEach(async () => {
    h = createHarness({ gracePeriodMs: 2_000 });
    clients = [h.client(), h.client()];
    roomId = (await clients[0]!.createRoom('E2E')).id;
  });

  it('converges both participants on the server order after concurrent edits', async () => {
    const a = join(0, 'Ada');
    const b = join(1, 'Bo');
    await vi.waitFor(() => expect(a.getState().canEdit && b.getState().canEdit).toBe(true));
    a.apply({ kind: 'create', shape: rect('r1') });
    await vi.waitFor(() => expect(b.getState().shapes.has('r1')).toBe(true));
    for (let i = 0; i < 10; i++) {
      a.apply({ kind: 'update', id: 'r1', patch: { x: i } });
      b.apply({ kind: 'update', id: 'r1', patch: { x: 100 + i } });
    }
    await vi.waitFor(() => {
      expect(a.getState().revision).toBe(21);
      expect(b.getState().revision).toBe(21);
      expect(a.getState().save).toBe('saved');
    });
    expect(a.getState().shapes).toEqual(b.getState().shapes);
    const server = await clients[0]!.getRoom(roomId);
    expect(a.getState().shapes.get('r1')).toEqual(server.canvas.shapes[0]);
    a.dispose();
    b.dispose();
  });

  it('reloads edits made by the other participant while it was disconnected', async () => {
    // A long first reconnect delay gives B a deterministic window to edit while A is away.
    const a = join(0, 'Ada', [400]);
    const b = join(1, 'Bo');
    await vi.waitFor(() => expect(a.getState().canEdit && b.getState().canEdit).toBe(true));
    const aId = a.getState().me!.id;

    clients[0]!.simulateNetworkDrop!();
    await vi.waitFor(() => expect(a.getState().connection).toBe('reconnecting'));
    b.apply({ kind: 'create', shape: rect('while-away') });
    await vi.waitFor(() => expect(b.getState().revision).toBe(1));
    expect(a.getState().shapes.size).toBe(0);

    await vi.waitFor(() => expect(a.getState().connection).toBe('connected'));
    expect(a.getState().me!.id).toBe(aId);
    expect([...a.getState().shapes.keys()]).toEqual(['while-away']);
    a.dispose();
    b.dispose();
  });
});
