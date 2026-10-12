# System Design Interview Platform — MVP V0 Specification

**Status:** Scope finalized  
**Purpose:** A local-first, real-time collaborative whiteboard for one-on-one system-design interviews.

## 1. Product overview

An interviewer creates a titled session and shares a room URL. Both participants join as guests, enter display names, and collaboratively draw system-design diagrams. Each participant sees the other's drawing updates and named cursor in real time. A single FastAPI backend handles WebSocket events and saves the full canvas as JSON in SQLite. Sessions can be reopened through their URLs; completed sessions are permanently read-only.

**Stack:** React + Vite, React Konva, FastAPI, WebSockets, SQLite, pytest, Vitest.  
**Deployment:** Local development only; no Docker or cloud deployment required for V0.

## 2. End-to-end user flow

1. Open the homepage and enter an interview title (e.g., “Design a URL Shortener”).
2. Create a room and receive a shareable URL.
3. Open the room URL and enter a guest display name.
4. A second participant opens the same URL and enters their display name (maximum two active participants).
5. Both edit the same freeform canvas. Shape changes synchronize over WebSockets, and the other participant's cursor appears with their name.
6. The backend applies events in server order and saves the full canvas JSON after a 500 ms idle period.
7. If a participant disconnects, editing is disabled locally. The app attempts automatic reconnection and reloads the latest authoritative canvas. A returning participant can reclaim their slot during a short grace period using a browser-stored token.
8. Either participant may export the entire diagram as PNG.
9. Either participant may click **End Session**, confirm the irreversible action, and finalize the canvas.
10. The room URL remains accessible for read-only review with pan and zoom.

## 3. Final V0 requirements

### 3.1 Rooms and access

- Create a room using a required interview title.
- Generate an unguessable shareable room URL.
- No account creation, login, or authentication.
- Guest display name required before entering the canvas.
- At most two active participants per room; both have identical permissions.
- No role-specific controls: either participant can edit, share the link, export, or end the session.
- Rooms are accessed only by their URL; no dashboard, session list, or recent-room history.
- Sessions are persistent in SQLite and remain accessible after both participants disconnect.
- Reserve a disconnected participant's slot briefly to support automatic reconnection; use a browser-stored participant token. Exact grace-period duration is an implementation detail to define.
- When a room is empty and pending changes are saved, release its in-memory resources without marking the room completed.

### 3.2 Whiteboard and editing

- Freeform whiteboard rather than a predefined system-design component palette.
- Drawing tools: rectangle, ellipse, arrow, straight line, and text.
- Selection tool: select, move, resize, and delete objects.
- Edit text directly on the canvas.
- Arrows and lines can attach to shapes; their endpoints update when connected shapes move or resize.
- Basic styling: shape fill color, line color, and text color using a small toolbar.
- Infinite canvas with pan and zoom.
- Each participant controls their own viewport independently; viewport positions are not synchronized.
- Mouse/toolbar interaction only; no keyboard shortcuts for V0.
- No undo/redo in V0.
- No smart connector auto-routing, images, grouping, or advanced styling in V0.

### 3.3 Real-time collaboration

- Both participants can edit simultaneously.
- Broadcast individual shape create/update/delete events over WebSockets.
- Broadcast shape movement during dragging at a throttled rate of approximately 50 ms, with a final event on mouse release.
- Display the remote participant's live cursor with their guest name; no participant sidebar or online-status list.
- No editing locks or visual edit-ownership indicators.
- Last-write-wins for concurrent edits to the same shape, ordered by the server.
- Use server-issued revisions or an equivalent ordering mechanism to prevent stale events from overwriting newer authoritative state.
- Cursor updates are ephemeral and not persisted to SQLite.

### 3.4 Persistence

- A single FastAPI process maintains active room connections and authoritative canvas state in memory.
- SQLite persists room metadata, status, canvas JSON, and timestamps.
- Broadcast accepted drawing events immediately; debounce complete-canvas JSON writes by approximately 500 ms after the latest change.
- Save pending changes before completing a session or cleaning up an empty room.
- Serialize or otherwise safely coordinate database writes per room to avoid out-of-order snapshots.
- The server, not either browser, is the authoritative source of the shared canvas.
- Persistence uses full canvas snapshots, not an event log or per-object database records.

### 3.5 Disconnection and recovery

- Automatically attempt WebSocket reconnection after an interruption.
- Show connection states: **Connected**, **Reconnecting**, **Disconnected**.
- Disable drawing/editing whenever the client is disconnected.
- On reconnect, load the latest authoritative server canvas; no offline edits or queued offline operations.
- Show save states: **Saving**, **Saved**. Acknowledgments should reflect actual server persistence, not merely local rendering.
- Reclaim the previous participant slot using a browser-stored token during a short reservation window.

### 3.6 Session lifecycle and export

- Active rooms stay active after everyone leaves; inactivity does not automatically complete them.
- Either participant can end a session.
- Ending requires a confirmation dialog warning that the action is permanent.
- A completed session is permanently read-only, including after reopening its URL.
- Completed rooms still allow pan, zoom, and diagram review.
- Export the **entire** diagram, not only the current viewport, as a PNG image.
- No JSON export in V0.

### 3.7 Testing and deployment

- Local development only: React frontend and one FastAPI backend, tested using two browser windows.
- Backend unit and integration tests with pytest: REST endpoints, WebSocket events, room capacity, event ordering, completion, reconnection, and SQLite persistence.
- Frontend unit tests with Vitest: drawing logic, shape manipulation, event handling, and connection state.
- Manual two-browser verification for collaborative behavior.
- No Playwright automation, Redis, message broker, Docker requirement, or public cloud deployment in V0.

## 4. Technical architecture

```text
Participant A (React + React Konva)      Participant B (React + React Konva)
                 |                                       |
                 +------------- WebSockets --------------+
                                      |
                            FastAPI (single process)
                            | REST API + WS endpoint
                            | In-memory room manager
                            | - Active connections
                            | - Authoritative canvas
                            | - Drawing events
                            | - Ephemeral cursors
                            | - Reconnect reservations
                                      |
                             Debounced snapshot writes
                                      |
                                   SQLite
                         - Rooms and metadata
                         - Active/completed status
                         - Full canvas JSON
                         - Timestamps
```

### Recommended event flow

1. User edits a shape locally.
2. Client sends an object-level drawing event to FastAPI.
3. FastAPI validates the event and room state, applies it in server order, and updates the authoritative in-memory canvas.
4. FastAPI broadcasts the accepted change (with its server revision) to room participants.
5. Frontends apply authoritative updates; remote cursors travel over separate ephemeral messages.
6. A 500 ms debounce triggers a complete-canvas snapshot write to SQLite.
7. Save status becomes **Saved** after successful persistence.

**Important distinction:** Object-level WebSocket messages and full-canvas SQLite snapshots are intentionally different. Do not broadcast competing whole-canvas replacements from each browser.

## 5. Suggested implementation phases

### Phase 1 — Foundation

- Initialize React/Vite frontend and FastAPI backend.
- Set up SQLite persistence.
- Implement room creation, title, shareable URL, and guest-name joining.
- Implement basic active/completed room lifecycle.

### Phase 2 — Whiteboard editor

- Build canvas using React Konva.
- Add rectangle, ellipse, line, arrow, and text tools.
- Implement selection, dragging, resizing, text editing, and deletion.
- Add shape-attached connectors, basic colors, and independent pan/zoom.

### Phase 3 — Real-time collaboration

- Implement the in-memory WebSocket room manager.
- Synchronize object-level drawing operations.
- Add throttled dragging updates, server revision ordering, last-write-wins, and named remote cursors.
- Enforce two active participant slots.

### Phase 4 — Persistence and recovery

- Implement 500 ms debounced full-canvas SQLite autosave.
- Add connection and save indicators.
- Implement automatic reconnect, participant token/grace period, and authoritative state reload.
- Flush pending changes and clean up empty rooms.

### Phase 5 — Completion, export, and quality

- Implement irreversible End Session with confirmation and read-only review.
- Implement full-diagram PNG export.
- Add pytest backend unit/integration tests and Vitest frontend tests.
- Manually test two-browser collaboration and recovery scenarios.

## 6. Explicitly out of scope for V0

- User accounts, authentication, permissions by role.
- Session dashboards, directory, or recent-room lists.
- More than two active participants.
- Undo/redo and keyboard shortcuts.
- Freehand pen, image uploads, grouping, smart auto-routing, advanced styling.
- Audio, video, chat, interview timer, or waiting room.
- Offline editing, queued offline changes, CRDTs, and shared editing locks.
- Event-sourcing/history/replay and per-object database persistence.
- Redis, distributed workers, message brokers, or multi-instance synchronization.
- Cloud deployment, Docker Compose, or automated browser E2E tests.

## 7. Decisions to specify during technical design

These are implementation-level details, not additional product scope:

- Exact REST routes and WebSocket message schemas.
- SQLite schema and JSON object representation, including shape IDs and connector references.
- How server revisions and client acknowledgments are generated and applied.
- How to debounce persistence and handle database errors safely.
- Reconnection grace-period duration and token lifecycle.
- How to define the canvas bounding box for full-diagram PNG export.
- How to handle a browser refresh while a room is at its two-participant limit.
- Error responses for full rooms, missing rooms, and completed rooms.

## 8. MVP acceptance criteria

- Two browser windows can join the same titled room with different display names.
- A third simultaneous participant cannot enter an occupied room.
- Both participants can create, move, resize, recolor, and delete shapes and edit text.
- Attached connectors follow their shapes.
- Changes and named remote cursors appear in the other window in real time.
- Both users can edit the same shape; the server's accepted order determines the result.
- Canvas snapshots survive a FastAPI restart and reload from SQLite.
- A temporarily disconnected user cannot edit and can reconnect without losing the authoritative canvas.
- Empty-room cleanup does not delete or complete a room.
- A user can export the whole diagram as PNG.
- Either participant can confirm completion; subsequent attempts to edit are rejected, and the room remains viewable.
- Backend and frontend automated tests pass locally.

---

**Next planned step:** Detailed technical specification: SQLite schema → REST endpoints → WebSocket event contracts → frontend component structure → implementation tasks.
