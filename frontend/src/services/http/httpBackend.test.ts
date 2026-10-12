import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../types';
import { createHttpBackend } from './httpBackend';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed: { code?: number } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number) {
    this.closed = { code };
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

function backend(fetchImpl: typeof fetch) {
  FakeWebSocket.instances = [];
  return createHttpBackend({
    fetch: fetchImpl,
    wsBase: 'ws://api.test',
    WebSocket: FakeWebSocket as unknown as typeof WebSocket,
  });
}

describe('http backend — REST', () => {
  it('creates a room with a JSON POST', async () => {
    const fetchMock = vi.fn(async () => json(201, { id: 'r1', title: 'T' }));
    const room = await backend(fetchMock as unknown as typeof fetch).createRoom('T');
    expect(room).toEqual({ id: 'r1', title: 'T' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/rooms');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ title: 'T' });
  });

  it('turns the server error body into an ApiError', async () => {
    const api = backend((async () => json(404, { error: { code: 'room_not_found', message: 'Room not found.' } })) as unknown as typeof fetch);
    const error = await api.getRoom('a/b').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, code: 'room_not_found', message: 'Room not found.' });
  });

  it('reports an unreachable server as status 0', async () => {
    const api = backend((async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch);
    await expect(api.getRoom('x')).rejects.toMatchObject({ status: 0, code: 'network_error' });
  });

  it('escapes the room id in the URL', async () => {
    const fetchMock = vi.fn(async () => json(200, {}));
    await backend(fetchMock as unknown as typeof fetch).getRoom('a/b');
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/rooms/a%2Fb');
  });
});

describe('http backend — WebSocket', () => {
  it('connects with name and token, parses messages and serializes sends', () => {
    const api = backend(vi.fn() as unknown as typeof fetch);
    const onMessage = vi.fn();
    const onOpen = vi.fn();
    const socket = api.connectRoom('room1', { name: 'Ada L', token: 'tok' }, { onOpen, onMessage, onClose: vi.fn() });
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toBe('ws://api.test/ws/rooms/room1?name=Ada+L&token=tok');

    socket.send({ type: 'end_session' });
    expect(ws.sent).toEqual([]); // not open yet: dropped, never queued offline
    ws.open();
    expect(onOpen).toHaveBeenCalled();
    socket.send({ type: 'cursor', position: null });
    expect(ws.sent).toEqual([JSON.stringify({ type: 'cursor', position: null })]);

    ws.onmessage?.({ data: JSON.stringify({ type: 'saved', revision: 3 }) });
    ws.onmessage?.({ data: 'not json' });
    expect(onMessage.mock.calls).toEqual([[{ type: 'saved', revision: 3 }]]);
  });

  it('omits the token when there is none', () => {
    const api = backend(vi.fn() as unknown as typeof fetch);
    api.connectRoom('room1', { name: 'Ada' }, { onOpen: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });
    expect(FakeWebSocket.instances[0]!.url).toBe('ws://api.test/ws/rooms/room1?name=Ada');
  });

  it('reports server closes but stays silent after the client closes (with code 1000)', () => {
    const api = backend(vi.fn() as unknown as typeof fetch);
    const onClose = vi.fn();
    const onMessage = vi.fn();
    const first = api.connectRoom('r', { name: 'A' }, { onOpen: vi.fn(), onMessage, onClose });
    FakeWebSocket.instances[0]!.onclose?.({ code: 4003, reason: 'room_full' });
    expect(onClose).toHaveBeenCalledWith({ code: 4003, reason: 'room_full' });

    const second = api.connectRoom('r', { name: 'A' }, { onOpen: vi.fn(), onMessage, onClose });
    const ws = FakeWebSocket.instances[1]!;
    second.close();
    expect(ws.closed).toEqual({ code: 1000 });
    ws.onmessage?.({ data: JSON.stringify({ type: 'saved', revision: 1 }) });
    ws.onclose?.({ code: 1000, reason: '' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onMessage).not.toHaveBeenCalled();
    void first;
  });
});
