import type { ClientMessage, Room, RoomDetail, ServerMessage } from '../protocol';
import { ApiError, type BackendService, type RoomSocket, type RoomSocketHandlers } from '../types';
import type { HostToTab, PortLike, TabToHost } from './portProtocol';

export interface PortBackendOptions {
  /** Send heartbeats at this interval (SharedWorker mode; see servePort's liveness timeout). */
  heartbeatMs?: number;
}

/** BackendService that talks to a mock server over a MessagePort. */
export function createPortBackend(port: PortLike, options: PortBackendOptions = {}): BackendService {
  let nextId = 1;
  const rpcs = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const sockets = new Map<number, RoomSocketHandlers>();
  const post = (message: TabToHost) => port.postMessage(message);

  port.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data as HostToTab;
    switch (msg.kind) {
      case 'rpc_result': {
        const call = rpcs.get(msg.id);
        rpcs.delete(msg.id);
        if (!call) return;
        if (msg.ok) call.resolve(msg.value);
        else call.reject(new ApiError(msg.error.status, msg.error.code, msg.error.message));
        return;
      }
      case 'opened':
        sockets.get(msg.connId)?.onOpen();
        return;
      case 'message':
        sockets.get(msg.connId)?.onMessage(JSON.parse(msg.data) as ServerMessage);
        return;
      case 'closed': {
        const handlers = sockets.get(msg.connId);
        sockets.delete(msg.connId);
        handlers?.onClose({ code: msg.code, reason: msg.reason });
        return;
      }
    }
  });
  port.start?.();

  if (options.heartbeatMs) {
    setInterval(() => post({ kind: 'heartbeat' }), options.heartbeatMs);
    // Tell the worker immediately when the tab goes away, so the other
    // participant sees the cursor disappear without waiting for the watchdog.
    globalThis.addEventListener?.('pagehide', () => post({ kind: 'bye' }));
  }

  function rpc<T>(method: 'createRoom' | 'getRoom', arg: string): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      rpcs.set(id, { resolve: resolve as (value: unknown) => void, reject });
      post({ kind: 'rpc', id, method, arg });
    });
  }

  return {
    kind: 'mock',

    createRoom: (title) => rpc<Room>('createRoom', title),

    getRoom: (roomId) => rpc<RoomDetail>('getRoom', roomId),

    connectRoom(roomId, params, handlers): RoomSocket {
      const connId = nextId++;
      sockets.set(connId, handlers);
      post({ kind: 'open', connId, roomId, name: params.name, token: params.token ?? null });
      return {
        send(message: ClientMessage) {
          if (sockets.has(connId)) post({ kind: 'send', connId, data: JSON.stringify(message) });
        },
        close(options) {
          if (sockets.delete(connId)) post({ kind: 'close', connId, normal: !options?.reconnecting });
        },
      };
    },

    simulateNetworkDrop() {
      post({ kind: 'drop' });
    },
  };
}
