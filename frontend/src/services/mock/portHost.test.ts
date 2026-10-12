import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockServer } from './mockServer';
import { servePort } from './portHost';
import type { HostToTab, PortLike, TabToHost } from './portProtocol';
import { MemoryRoomStore } from './roomStore';

/** A synchronous in-memory port, so fake timers fully control the host. */
function fakePort() {
  let listener: ((e: MessageEvent) => void) | null = null;
  const received: HostToTab[] = [];
  const port: PortLike = {
    postMessage: (m) => received.push(m as HostToTab),
    addEventListener: (_t, l) => (listener = l),
    removeEventListener: () => (listener = null),
  };
  const send = (m: TabToHost) => listener?.({ data: m } as MessageEvent);
  return { port, received, send };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('servePort', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function joined() {
    const server = new MockServer({ store: new MemoryRoomStore() });
    const room = await server.createRoom('t');
    const tab = fakePort();
    const stop = servePort(server, tab.port, { livenessTimeoutMs: 7_000 });
    tab.send({ kind: 'open', connId: 1, roomId: room.id, name: 'Ada', token: null });
    await flush();
    expect(tab.received.some((m) => m.kind === 'message' && m.data.includes('"welcome"'))).toBe(true);
    return { tab, stop };
  }

  it('tells a tab that missed its heartbeats that its connection is gone', async () => {
    const { tab, stop } = await joined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tab.received).toContainEqual({ kind: 'closed', connId: 1, code: 1006, reason: 'connection lost' });
    stop();
  });

  it('keeps a tab that keeps sending heartbeats', async () => {
    const { tab, stop } = await joined();
    for (let i = 0; i < 10; i++) {
      tab.send({ kind: 'heartbeat' });
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(tab.received.some((m) => m.kind === 'closed')).toBe(false);
    stop();
  });

  it('answers traffic on a connection it no longer knows with a close', async () => {
    const { tab, stop } = await joined();
    tab.send({ kind: 'send', connId: 99, data: '{}' });
    expect(tab.received.at(-1)).toEqual({ kind: 'closed', connId: 99, code: 1006, reason: 'connection lost' });
    stop();
  });

  it('notifies the tab of connections dropped on pagehide, in case it is restored', async () => {
    const { tab, stop } = await joined();
    tab.send({ kind: 'bye' });
    expect(tab.received.at(-1)).toMatchObject({ kind: 'closed', connId: 1, code: 1006 });
    stop();
  });
});
