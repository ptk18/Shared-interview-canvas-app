# Sketchroom: system design interview whiteboard

A local-first, real-time collaborative whiteboard for one-on-one system design
interviews. One person creates a titled room and shares its link, and both
participants draw on the same canvas, seeing each other's edits and named
cursors live. Either participant can end the session, which makes the diagram
permanently read-only.

- Spec: [`_docs/plan.md`](_docs/plan.md)
- Wire protocol (the contract both backends implement): [`_docs/protocol.md`](_docs/protocol.md)

## Quick start

```bash
make install   # once
make dev       # backend + frontend → http://localhost:5173 (Ctrl-C stops both)
make mock      # frontend only, on the in-browser mock backend
make test      # all tests
make help      # everything else
```

`make dev` runs the backend on port 8001; use `make dev BACKEND_PORT=8000` to
change it. The sections below describe the same steps without `make`.

### Without a backend (mock mode)

```bash
cd frontend
npm install
npm run dev:mock        # http://localhost:5173
```

The whole app runs against an in-browser mock server. It lives in a
SharedWorker, so **two tabs of the same browser can collaborate** with no backend
running. Rooms persist in IndexedDB. The top bar shows `mock backend` and a
**simulate drop** link for testing reconnection.

### With the FastAPI backend

```bash
# terminal 1
cd backend
uv sync
uv run uvicorn app.main:app --port 8000

# terminal 2
cd frontend
npm install
npm run dev             # proxies /api and /ws to localhost:8000
```

If port 8000 is taken, run uvicorn on another port and start Vite with
`SDI_BACKEND_URL=http://127.0.0.1:8001 npm run dev`. Run uvicorn as a **single
process** (no `--workers`), because room state lives in memory.

To try collaboration, open the room link in two windows. Each tab is its own
participant, and its seat token lives in `sessionStorage`.

## Tests

```bash
cd backend  && uv run pytest -q       # REST, WebSocket, persistence, reconnection, validation
cd frontend && npm test               # session engine, mock server, geometry, services, components
cd frontend && npm run typecheck
```

Both suites run [`shared/op-validation-cases.json`](shared/op-validation-cases.json),
so the FastAPI validator and the mock validator cannot drift apart.

## Architecture

```
frontend/src
  services/            every backend call goes through here
    types.ts           BackendService interface (createRoom, getRoom, connectRoom)
    protocol.ts        wire types mirrored from _docs/protocol.md
    http/              real implementation: fetch + WebSocket
    mock/              mock implementation: MockServer + validation, served to tabs
                       over a MessagePort (SharedWorker, or in-tab fallback)
    index.ts           picks the backend from VITE_BACKEND; React context
  room/roomSession.ts  client engine: server-confirmed canvas + optimistic pending
                       ops, revision ordering, reconnect with backoff, save status
  canvas/              pure logic: ops, geometry (connector attachment), export
  components/          React UI; Whiteboard.tsx is the Konva canvas

backend/app
  rooms.py             in-memory room manager: slots, grace timers, ordered
                       broadcast, debounced snapshots, end session
  canvas.py            op validation and application
  db.py                SQLite snapshot persistence
  main.py              FastAPI app (REST + WebSocket)
```

Key behaviours:

- **Server order wins.** The server applies each op, assigns it a revision and
  broadcasts it. Clients show their own edits immediately and reconcile when
  the server echoes them. Ops at or below the revision a client already holds
  are ignored.
- **Persistence** writes a full-canvas snapshot to SQLite 500 ms after the last
  change. The **Saved** status means the server confirmed the write.
- **Reconnection:** while disconnected, editing is disabled and unconfirmed
  edits are dropped. On reconnect the client reloads the authoritative canvas
  and reclaims its seat with its token. A dropped seat is held for 30 seconds;
  leaving on purpose frees it immediately.
- **Connectors** store bindings to shapes, and their endpoints are computed from
  shape geometry, so they follow shapes when those move or resize.
- **Export** renders the whole diagram, not just the viewport, to PNG on white.

## Using the whiteboard

There are no keyboard shortcuts in V0; everything works from the toolbar.

- **Draw:** pick rectangle, ellipse, arrow, line or text, then drag (or click)
  on the canvas. Drawing an arrow or line from one shape to another attaches
  it to both.
- **Select:** move by dragging, resize with the handles, double-click a shape
  or text to edit it, and use the trash button to delete. Drag a selected
  connector's end handles to re-attach them.
- **Navigate:** scroll to zoom, and drag empty canvas (or use the hand tool) to
  pan.
