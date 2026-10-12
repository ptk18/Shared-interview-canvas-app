# Wire Protocol — V0

This document is the contract between the React client and any backend that
serves it. Two backends implement it:

- **FastAPI** (`backend/`) — the real, SQLite-backed server.
- **Mock** (`frontend/src/services/mock/`) — an in-browser server used when the
  app runs without a real backend.

Both must behave identically for everything described here. Shape/op
validation parity is enforced by the shared fixture
`shared/op-validation-cases.json`, which both test suites execute.

All JSON uses camelCase keys. Timestamps are ISO-8601 UTC strings
(e.g. `2026-10-12T09:41:07.123Z` or `2026-10-12T09:41:07.123000+00:00`).

## 1. Data model

### Room

```json
{
  "id": "Xq3...22 url-safe chars",
  "title": "Design a URL Shortener",
  "status": "active",            // "active" | "completed"
  "createdAt": "…",
  "updatedAt": "…",
  "completedAt": null            // string once completed
}
```

Room ids are unguessable: at least 128 bits of randomness, URL-safe base64
(`secrets.token_urlsafe(16)` → 22 chars).

### Canvas

```json
{ "revision": 12, "shapes": [Shape, ...] }
```

`shapes` is ordered by z-order (first = bottom). A created shape is appended;
an update keeps the shape's position; a delete removes it.

`revision` starts at `0` for a new room and increases by exactly 1 for every
accepted op. It is persisted together with the shapes.

### Shape

All fields are required on create. Unknown fields are rejected.

| type                | fields |
|---------------------|--------|
| `rect`, `ellipse`   | `id, type, x, y, width, height, fill, stroke, label, textColor` |
| `text`              | `id, type, x, y, width, text, fontSize, textColor` |
| `line`, `arrow`     | `id, type, x1, y1, x2, y2, stroke, start, end` |

Field rules:

- `id`: string matching `^[A-Za-z0-9_-]{1,64}$`.
- `x, y, x1, y1, x2, y2`: finite number (int or float; **not** bool, **not**
  numeric string), `-1_000_000 ≤ v ≤ 1_000_000`.
- `width, height` (rect/ellipse): finite number, `0 ≤ v ≤ 1_000_000`.
- `width` (text): finite number, `1 ≤ v ≤ 1_000_000`.
- `fontSize`: finite number, `8 ≤ v ≤ 200`.
- `fill, stroke, textColor`: `"transparent"` or `#rrggbb` (exactly 6 hex digits,
  either case).
- `label`: string, at most 2000 characters (may be empty).
- `text`: string, at most 5000 characters (may be empty).
- Throughout this document, string lengths are counted in **Unicode code
  points** (Python `len()`, JavaScript `[...s].length`), not UTF-16 units.
- `start, end`: `null` or a binding object `{"shapeId": "<id>"}` (no other keys;
  `shapeId` must match the `id` pattern, otherwise `invalid_op`).
  A non-null binding must reference a shape that **currently exists** in the
  canvas, whose type is `rect`, `ellipse` or `text`, and which is not the
  connector itself.

Connector endpoints are *rendered* by the client: a bound endpoint is
computed from the bound shape's geometry, so it follows the shape when it
moves or resizes. `x1..y2` are the fallback coordinates used when an endpoint
is unbound (or its target no longer exists). The server never rewrites
bindings — e.g. deleting a shape does not touch connectors bound to it.

## 2. Ops

```json
{ "kind": "create", "shape": Shape }
{ "kind": "update", "id": "<shape id>", "patch": { ...subset of fields... } }
{ "kind": "delete", "id": "<shape id>" }
```

Applying an op to a canvas (identical in both backends):

| op | rejected with code | when |
|----|--------------------|------|
| any | `invalid_op` | not an object, unknown `kind`, missing/extra top-level keys, `id` not a string |
| create | `invalid_op` | shape fails the field rules above (except binding existence) |
| create | `duplicate_id` | a shape with the same id exists |
| create | `canvas_full` | the canvas already holds 2000 shapes |
| create | `invalid_binding` | `start`/`end` is non-null and fails the binding rules |
| update | `shape_not_found` | no shape with that id |
| update | `invalid_op` | `patch` not an object, contains `id`/`type` or a field that the shape's type does not have, or the merged shape fails the field rules. An empty patch is valid. |
| update | `invalid_binding` | `patch` contains `start`/`end` with a non-null binding that fails the binding rules (bindings *not* in the patch are not re-checked, so a connector whose target was deleted can still be moved) |
| delete | `shape_not_found` | no shape with that id |

Check order: `invalid_op` (structure/fields) → `duplicate_id` / `shape_not_found`
→ `canvas_full` → `invalid_binding`. For `update`, `shape_not_found` is checked
before the patch is validated (the patch keys depend on the shape type).

Accepted ops are echoed in normalized form: `create` carries the full shape;
`update` carries exactly the validated patch; `delete` carries the id.

Concurrent edits are last-write-wins **in server order**: the server applies ops
one at a time, assigns each the next revision, and broadcasts it. A patch only
overwrites the fields it contains.

## 3. REST

Errors always have the body `{"error": {"code": "...", "message": "..."}}`.

| method & path | success | errors |
|---|---|---|
| `GET /api/health` | `200 {"status": "ok"}` | |
| `POST /api/rooms` body `{"title": string}` | `201 Room` | `422 invalid_title` (title missing/not a string, blank or > 120 chars after trimming, or containing a NUL character); `422 invalid_request` (body not a JSON object) |
| `GET /api/rooms/{roomId}` | `200 Room & {"canvas": Canvas}` | `404 room_not_found` |

The title is stored trimmed. `updatedAt` advances with every accepted op. For a room that is live in server memory, `GET`
returns the in-memory (authoritative) canvas, which may be newer than the last
SQLite snapshot.

## 4. WebSocket

`/ws/rooms/{roomId}?name=<display name>&token=<participant token, optional>`

The server always **accepts** the handshake. It then either sends `welcome` or
sends `error` and closes with one of these codes:

| close code | `error.code` | meaning | client reconnects? |
|---|---|---|---|
| 4000 | `invalid_name` | name missing, blank, or > 40 chars after trimming | no |
| 4001 | `replaced` | another connection claimed this participant's token | no |
| 4003 | `room_full` | two participant slots already taken | no |
| 4004 | `room_not_found` | unknown room | no |
| 4009 | `room_completed` | room is completed (also used after `session_ended`) | no |

Join checks run in this order: name, then room existence, then completion,
then slot availability.

Any other close (network drop, server restart, 1006, 1001, 1011…) is treated as
an interruption and the client reconnects with its token.

### Participants, slots, reconnection

- A room has **2 participant slots**. A slot is held by a participant while
  connected, and for a **grace period** (default 30 s, configurable) after the
  connection drops.
- Joining with a `token` that matches a slot holder (connected or within grace)
  reclaims that slot: same participant id, same colour, name updated to the new
  `name`. If that participant still has an open connection (e.g. a browser
  refresh raced the old socket's close), the old connection receives
  `error replaced` and is closed with 4001.
- Joining without a matching token takes a free slot and receives a new
  participant id and token (≥128-bit random). If none is free → `room_full`.
- Participant colours are `#e8590c` and `#1c7ed6`; a new participant gets the
  first colour not used by the other slot holder.
- When the grace period of a disconnected participant expires, its slot is
  released.
- A participant whose client closes the socket with **code 1000** (leaving on
  purpose, e.g. navigating away inside the app) gives up the slot immediately,
  without a grace period. Any other close keeps the grace period: drops and page
  reloads (1001, 1006, …), and **4100**, which a client sends when it abandons a
  connection that stopped acknowledging its edits and is about to reconnect.
- Reclaiming a slot whose previous connection is still open (a takeover) sends
  no `participant_joined`/`participant_left` to the other participant, because
  nobody left.
- When a room has no connected participants and no reserved slots, the server
  flushes any pending snapshot and releases the room's in-memory state. The
  room stays `active` in SQLite.

### Server → client

```jsonc
{ "type": "welcome",
  "participant": { "id": "p_…", "name": "Ada", "color": "#e8590c" },
  "token": "…",                    // store per tab; send back on reconnect
  "room": Room,
  "canvas": Canvas,                // authoritative state; replaces client state
  "savedRevision": 12,             // highest revision persisted to SQLite
  "participants": [Participant] }  // OTHER currently-connected participants

{ "type": "op", "revision": 13, "op": Op, "participantId": "p_…", "clientOpId": "c_…" }
{ "type": "op_rejected", "clientOpId": "c_…", "code": "shape_not_found", "message": "…" }
{ "type": "cursor", "participantId": "p_…", "name": "Ada", "color": "#e8590c",
  "position": { "x": 10.5, "y": -3 } }          // position null = cursor left canvas
{ "type": "participant_joined", "participant": Participant }
{ "type": "participant_left", "participantId": "p_…" }   // on disconnect
{ "type": "saved", "revision": 13 }             // snapshot up to 13 is in SQLite
{ "type": "save_failed", "message": "…" }       // snapshot write failed; server retries
{ "type": "session_ended", "room": Room, "canvas": Canvas }
{ "type": "error", "code": "…", "message": "…" }
```

Ordering guarantee: each connection receives messages in the order the server
produced them (one outbound queue per connection). `op` messages therefore
arrive in strictly increasing revision order after `welcome`. Clients ignore any
`op` whose revision is `<=` the revision they already hold.

`op` is broadcast to **every** connected participant, including the sender
(the sender recognizes its own op by `clientOpId`). `op_rejected` goes only to
the sender. `cursor` goes to everyone **except** its sender.
`participant_joined` / `participant_left` go to everyone except the subject.

### Client → server

```jsonc
{ "type": "op", "clientOpId": "c_…", "op": Op }   // clientOpId: string, 1–64 chars
{ "type": "cursor", "position": { "x": 1, "y": 2 } | null }
{ "type": "end_session" }
```

- Malformed JSON, a non-object, an unknown `type`, or a structurally invalid
  `op`/`cursor` envelope (e.g. missing `clientOpId`) → `error` with code
  `invalid_message`; the connection stays open.
- `op` on a completed room → `op_rejected` with code `room_completed`
  (normally unreachable, since connections are closed on completion).
- A cursor `position` must be `null` or an object with exactly the keys `x` and
  `y`, both finite numbers; anything else → `invalid_message`.
- Extra top-level keys on an `op`/`cursor`/`end_session` envelope are ignored.
  Cursors are never persisted.

### Persistence

- Every accepted op is broadcast immediately and (re)starts a **500 ms**
  debounce timer (configurable). When it fires, the server writes the full
  canvas JSON + revision to SQLite and broadcasts `saved` with the persisted
  revision.
- Snapshot writes are serialized per room, and a write never replaces a
  snapshot with a higher revision.
- On a write failure, the server broadcasts `save_failed`, keeps the room dirty,
  and retries (≈2 s later). The room is never released while dirty.
- Pending changes are flushed before completing a session, before releasing an
  empty room, and on server shutdown.

### Ending a session

`end_session` → the server flushes pending changes, marks the room
`completed` (sets `completedAt`) in SQLite, broadcasts
`session_ended` (with the final room and canvas) to all participants, closes
every connection with 4009, and releases the room. If the flush fails, the
sender receives `error` with code `save_failed` and the room stays active.
Completion is permanent: later WebSocket joins get `room_completed`; `GET`
still returns the room and its canvas for read-only review.
