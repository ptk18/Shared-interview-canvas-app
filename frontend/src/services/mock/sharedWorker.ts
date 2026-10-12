// SharedWorker entry: one mock server shared by every tab of this origin, so two
// tabs can collaborate in a room with no real backend running.
/// <reference lib="webworker" />
import { MockServer } from './mockServer';
import { servePort } from './portHost';
import { IndexedDbRoomStore } from './roomStore';

declare const self: SharedWorkerGlobalScope;

const server = new MockServer({ store: new IndexedDbRoomStore() });

self.addEventListener('connect', (event: MessageEvent) => {
  const port = event.ports[0];
  if (port) servePort(server, port, { livenessTimeoutMs: 7_000 });
});
