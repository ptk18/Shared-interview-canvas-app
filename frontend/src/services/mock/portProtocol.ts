// Messages between a browser tab (PortBackend) and the mock server host (servePort),
// carried over a MessagePort — a SharedWorker's port, or an in-tab MessageChannel.
// Room traffic travels as JSON strings, exactly like a WebSocket, so the client
// and server never share object references.

export type TabToHost =
  | { kind: 'rpc'; id: number; method: 'createRoom' | 'getRoom'; arg: string }
  | { kind: 'open'; connId: number; roomId: string; name: string; token: string | null }
  | { kind: 'send'; connId: number; data: string }
  | { kind: 'close'; connId: number; normal: boolean }
  | { kind: 'drop' }
  | { kind: 'heartbeat' }
  | { kind: 'bye' };

export type HostToTab =
  | { kind: 'rpc_result'; id: number; ok: true; value: unknown }
  | { kind: 'rpc_result'; id: number; ok: false; error: { status: number; code: string; message: string } }
  | { kind: 'opened'; connId: number }
  | { kind: 'message'; connId: number; data: string }
  | { kind: 'closed'; connId: number; code: number; reason: string };

/** The subset of MessagePort both ends rely on. */
export interface PortLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  start?(): void;
}

/** Close code a browser reports when a connection drops without a close frame. */
export const ABNORMAL_CLOSURE = 1006;
