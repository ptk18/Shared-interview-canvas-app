import type { Canvas, Room } from '../protocol';

/** What the mock backend persists per room — the analogue of one SQLite row. */
export interface StoredRoom {
  room: Room;
  canvas: Canvas;
}

export interface RoomStore {
  get(roomId: string): Promise<StoredRoom | undefined>;
  put(record: StoredRoom): Promise<void>;
}

export class MemoryRoomStore implements RoomStore {
  private readonly rooms = new Map<string, string>();

  async get(roomId: string): Promise<StoredRoom | undefined> {
    const json = this.rooms.get(roomId);
    return json ? (JSON.parse(json) as StoredRoom) : undefined;
  }

  async put(record: StoredRoom): Promise<void> {
    this.rooms.set(record.room.id, JSON.stringify(record));
  }
}

const DB_NAME = 'sdi-mock-backend';
const STORE = 'rooms';

/** IndexedDB-backed store, so mock rooms survive reloads (works in windows and workers). */
export class IndexedDbRoomStore implements RoomStore {
  private db: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory: IDBFactory = indexedDB) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const request = this.factory.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.db;
  }

  private async run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async get(roomId: string): Promise<StoredRoom | undefined> {
    const value = await this.run<unknown>('readonly', (s) => s.get(roomId));
    return value === undefined ? undefined : (value as StoredRoom);
  }

  async put(record: StoredRoom): Promise<void> {
    await this.run('readwrite', (s) => s.put(record, record.room.id));
  }
}
