import { ApiError } from '../types';
import type { ClientHandle, MockServer } from './mockServer';
import { ABNORMAL_CLOSURE, type HostToTab, type PortLike, type TabToHost } from './portProtocol';

export interface ServePortOptions {
  /**
   * Treat the tab as gone if it sends nothing for this long. SharedWorker ports
   * have no reliable close event, so the tab sends heartbeats; without this a
   * crashed tab would hold its participant slot forever.
   */
  livenessTimeoutMs?: number;
}

/** Serves one tab's port: forwards its REST calls and room connections to the server. */
export function servePort(server: MockServer, port: PortLike, options: ServePortOptions = {}): () => void {
  const conns = new Map<number, ClientHandle>();
  const open = new Set<number>();
  let lastSeen = Date.now();
  const post = (message: HostToTab) => port.postMessage(message);

  const dropAll = (notifyTab: boolean) => {
    for (const [connId, handle] of conns) {
      handle.disconnect();
      if (notifyTab) post({ kind: 'closed', connId, code: ABNORMAL_CLOSURE, reason: 'connection lost' });
    }
    conns.clear();
    open.clear();
  };

  const onMessage = (event: MessageEvent) => {
    const msg = event.data as TabToHost;
    lastSeen = Date.now();
    switch (msg.kind) {
      case 'rpc': {
        const call = msg.method === 'createRoom' ? server.createRoom(msg.arg) : server.getRoom(msg.arg);
        call.then(
          (value) => post({ kind: 'rpc_result', id: msg.id, ok: true, value }),
          (error: unknown) => {
            const e = error instanceof ApiError ? error : new ApiError(500, 'internal_error', String(error));
            post({ kind: 'rpc_result', id: msg.id, ok: false, error: { status: e.status, code: e.code, message: e.message } });
          },
        );
        return;
      }
      case 'open': {
        const { connId } = msg;
        // Registered before connecting: the server may reject the join (and
        // close) synchronously, before connect() even returns.
        open.add(connId);
        post({ kind: 'opened', connId });
        const handle = server.connect(
          msg.roomId,
          { name: msg.name, token: msg.token },
          {
            send: (message) => {
              if (open.has(connId)) post({ kind: 'message', connId, data: JSON.stringify(message) });
            },
            close: (code, reason) => {
              if (!open.delete(connId)) return;
              conns.delete(connId);
              post({ kind: 'closed', connId, code, reason });
            },
          },
        );
        if (open.has(connId)) conns.set(connId, handle);
        return;
      }
      case 'send': {
        const handle = conns.get(msg.connId);
        if (handle) handle.receive(msg.data);
        // The worker dropped this connection while the tab was asleep; make sure it finds out.
        else post({ kind: 'closed', connId: msg.connId, code: ABNORMAL_CLOSURE, reason: 'connection lost' });
        return;
      }
      case 'close': {
        const handle = conns.get(msg.connId);
        conns.delete(msg.connId);
        open.delete(msg.connId);
        handle?.disconnect(msg.normal);
        return;
      }
      case 'drop':
        dropAll(true);
        return;
      case 'bye':
        // Posted to a page that is unloading, or one entering the back/forward cache
        // that may come back; either way it must learn its connections are gone.
        dropAll(true);
        return;
      case 'heartbeat':
        return;
    }
  };

  port.addEventListener('message', onMessage);
  port.start?.();

  const timeout = options.livenessTimeoutMs;
  const watchdog =
    timeout === undefined
      ? undefined
      : setInterval(() => {
          // A throttled background tab misses heartbeats; the queued close reaches it when it wakes.
          if (conns.size > 0 && Date.now() - lastSeen > timeout) dropAll(true);
        }, Math.max(250, timeout / 3));

  return () => {
    clearInterval(watchdog);
    port.removeEventListener('message', onMessage);
    dropAll(false);
  };
}
