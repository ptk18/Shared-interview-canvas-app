import type { ClientMessage, Room, RoomDetail, ServerMessage } from './protocol';

/** A failed backend request. `status` 0 means the backend could not be reached. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface RoomSocketHandlers {
  /** The connection is open; the server's `welcome` (or `error`) follows. */
  onOpen(): void;
  onMessage(message: ServerMessage): void;
  /** The connection closed for any reason other than the client calling `close()`. */
  onClose(event: { code: number; reason: string }): void;
}

/** A live room connection. After `close()`, no further handler callbacks fire. */
export interface RoomSocket {
  send(message: ClientMessage): void;
  /**
   * Closes the connection. By default this means leaving the room (close code
   * 1000, the seat is freed). With `reconnecting`, the client is abandoning a
   * dead connection and will rejoin, so the server keeps the seat reserved.
   */
  close(options?: { reconnecting?: boolean }): void;
}

export interface JoinParams {
  name: string;
  token?: string | null;
}

/**
 * Every call the app makes to a backend goes through this interface. Components
 * and hooks never use `fetch` or `WebSocket` directly.
 */
export interface BackendService {
  readonly kind: 'http' | 'mock';
  createRoom(title: string): Promise<Room>;
  getRoom(roomId: string): Promise<RoomDetail>;
  connectRoom(roomId: string, params: JoinParams, handlers: RoomSocketHandlers): RoomSocket;
  /** Mock only: simulate a network drop of this tab's room connections. */
  simulateNetworkDrop?(): void;
}
