import type { BackendService } from '../types';
import { MockServer } from './mockServer';
import { createPortBackend } from './portBackend';
import { servePort } from './portHost';
import { IndexedDbRoomStore } from './roomStore';

const HEARTBEAT_MS = 2_000;

/**
 * The mock backend. Prefers a SharedWorker so every tab talks to the same
 * server (two-tab collaboration works); falls back to a server inside this tab
 * when SharedWorker is unavailable (single-tab use only).
 */
export function createMockBackend(): BackendService {
  if (typeof SharedWorker !== 'undefined') {
    try {
      const worker = new SharedWorker(new URL('./sharedWorker.ts', import.meta.url), {
        type: 'module',
        name: 'sdi-mock-backend',
      });
      return createPortBackend(worker.port, { heartbeatMs: HEARTBEAT_MS });
    } catch (error) {
      console.warn('SharedWorker unavailable; mock backend is limited to this tab.', error);
    }
  }
  const channel = new MessageChannel();
  servePort(new MockServer({ store: new IndexedDbRoomStore() }), channel.port1);
  return createPortBackend(channel.port2);
}
