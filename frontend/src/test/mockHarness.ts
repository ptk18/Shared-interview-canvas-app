// Wires a MockServer to BackendService clients over real MessageChannels — the
// same transport the app uses in mock mode — for integration tests.
import { createPortBackend } from '../services/mock/portBackend';
import { servePort } from '../services/mock/portHost';
import { MockServer, type MockServerOptions } from '../services/mock/mockServer';
import { MemoryRoomStore, type RoomStore } from '../services/mock/roomStore';
import type { BackendService } from '../services/types';

export interface Harness {
  server: MockServer;
  store: RoomStore;
  /** A new "browser tab" connected to the shared server. */
  client(): BackendService;
  close(): void;
}

export function createHarness(options: Partial<MockServerOptions> = {}): Harness {
  const store = options.store ?? new MemoryRoomStore();
  const server = new MockServer({ saveDebounceMs: 20, gracePeriodMs: 150, saveRetryMs: 40, ...options, store });
  const cleanups: (() => void)[] = [];
  return {
    server,
    store,
    client() {
      const channel = new MessageChannel();
      cleanups.push(servePort(server, channel.port1), () => {
        channel.port1.close();
        channel.port2.close();
      });
      return createPortBackend(channel.port2);
    },
    close() {
      for (const fn of cleanups.splice(0)) fn();
    },
  };
}
