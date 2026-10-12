import type { ClientMessage, Room, RoomDetail, ServerMessage } from '../services/protocol';
import type { BackendService, JoinParams, RoomSocketHandlers } from '../services/types';

export interface FakeConnection {
  roomId: string;
  params: JoinParams;
  sent: ClientMessage[];
  closedByClient: boolean;
  closeOptions?: { reconnecting?: boolean };
  /** Deliver a server message to the client. */
  emit(message: ServerMessage): void;
  /** Close from the server/network side. */
  drop(code?: number, reason?: string): void;
}

/** A scriptable BackendService: tests play the server by hand. */
export class FakeBackend implements BackendService {
  readonly kind = 'mock' as const;
  readonly connections: FakeConnection[] = [];
  createRoom = async (_title: string): Promise<Room> => {
    throw new Error('not scripted');
  };
  getRoom = async (_roomId: string): Promise<RoomDetail> => {
    throw new Error('not scripted');
  };

  get last(): FakeConnection {
    const conn = this.connections.at(-1);
    if (!conn) throw new Error('no connection yet');
    return conn;
  }

  connectRoom(roomId: string, params: JoinParams, handlers: RoomSocketHandlers) {
    const conn: FakeConnection = {
      roomId,
      params,
      sent: [],
      closedByClient: false,
      emit: (m) => {
        if (!conn.closedByClient) handlers.onMessage(structuredClone(m));
      },
      drop: (code = 1006, reason = '') => {
        if (!conn.closedByClient) handlers.onClose({ code, reason });
      },
    };
    this.connections.push(conn);
    return {
      send: (m: ClientMessage) => conn.sent.push(structuredClone(m)),
      close: (options?: { reconnecting?: boolean }) => {
        conn.closedByClient = true;
        conn.closeOptions = options;
      },
    };
  }
}
