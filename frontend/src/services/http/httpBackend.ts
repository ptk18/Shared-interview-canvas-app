import type { ClientMessage, Room, RoomDetail, ServerMessage } from '../protocol';
import { ApiError, type BackendService, type JoinParams, type RoomSocket, type RoomSocketHandlers } from '../types';

export interface HttpBackendOptions {
  /** Origin for REST calls, e.g. `http://localhost:8000`. Defaults to same-origin (Vite proxies `/api`). */
  apiBase?: string;
  /** Origin for WebSockets, e.g. `ws://localhost:8000`. Defaults to the page's origin. */
  wsBase?: string;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
}

/** Application close code: "this connection looks dead, I'll be right back" (keeps the seat). */
export const RECONNECTING_CLOSE_CODE = 4100;

function defaultWsBase(): string {
  const { protocol, host } = window.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}`;
}

/** Backend implementation that talks to the FastAPI server over REST + WebSocket. */
export function createHttpBackend(options: HttpBackendOptions = {}): BackendService {
  const apiBase = options.apiBase ?? '';
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const WS = options.WebSocket ?? WebSocket;

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(`${apiBase}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...init?.headers },
      });
    } catch {
      throw new ApiError(0, 'network_error', 'Could not reach the server.');
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      throw new ApiError(
        response.status,
        typeof error?.code === 'string' ? error.code : 'http_error',
        typeof error?.message === 'string' ? error.message : `Request failed (${response.status}).`,
      );
    }
    return body as T;
  }

  return {
    kind: 'http',

    createRoom(title) {
      return request<Room>('/api/rooms', { method: 'POST', body: JSON.stringify({ title }) });
    },

    getRoom(roomId) {
      return request<RoomDetail>(`/api/rooms/${encodeURIComponent(roomId)}`);
    },

    connectRoom(roomId: string, params: JoinParams, handlers: RoomSocketHandlers): RoomSocket {
      const query = new URLSearchParams({ name: params.name });
      if (params.token) query.set('token', params.token);
      const base = options.wsBase ?? defaultWsBase();
      const ws = new WS(`${base}/ws/rooms/${encodeURIComponent(roomId)}?${query}`);
      let closedByClient = false;

      ws.onopen = () => {
        if (!closedByClient) handlers.onOpen();
      };
      ws.onmessage = (event: MessageEvent) => {
        if (closedByClient || typeof event.data !== 'string') return;
        let message: ServerMessage;
        try {
          message = JSON.parse(event.data) as ServerMessage;
        } catch {
          return;
        }
        handlers.onMessage(message);
      };
      ws.onclose = (event: CloseEvent) => {
        if (!closedByClient) handlers.onClose({ code: event.code, reason: event.reason });
      };

      return {
        send(message: ClientMessage) {
          if (ws.readyState === WS.OPEN) ws.send(JSON.stringify(message));
        },
        close(options) {
          if (closedByClient) return;
          closedByClient = true;
          if (options?.reconnecting) ws.close(RECONNECTING_CLOSE_CODE, 'reconnecting');
          else ws.close(1000, 'client closed');
        },
      };
    },
  };
}
