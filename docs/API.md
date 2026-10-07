# Team Office API (v1) — contract

Owned by the architect. `server/` implements it; `src/data/api/ApiDataSource.ts` consumes it.
Shapes are exactly the types in `src/data/types.ts` (JSON, ISO strings). Local-only: no auth.

- Server: `http://localhost:8787`. In dev, Vite proxies `/api` → `:8787`, so the app calls relative `/api/...`.
- Content type: `application/json; charset=utf-8`.
- Storage: SQLite file `server/data/office.db` via Node's built-in `node:sqlite` (no native deps).
  First start (empty DB) seeds from `src/data/mock/seed.ts` so both sources show the same office.

## Request hygiene (local-only, but browsers are hostile)

Any web page the user visits can fire requests at `localhost`. The server therefore rejects, with
`403 { error: { code: 'invalid', message: '허용되지 않은 요청이에요' } }`:
- a `Host` header other than `127.0.0.1:<port>` / `localhost:<port>` (DNS rebinding);
- an `Origin` header that is present and not an `http://localhost:*` / `http://127.0.0.1:*` origin;
- `POST`/`PUT`/`PATCH` without `Content-Type: application/json` (forces a CORS preflight, which
  the server never approves). Body-less writes such as `POST /api/reset` send `{}`.

The Vite proxy rewrites `Host` (`changeOrigin: true`), so the dev app passes.

## Actor

Every mutating request may carry `X-Actor: <memberId>`. Absent → the manager (the user), and
activities get `actorId: null`. The demo bot always sends it. Unknown actor → `400 invalid`.

`X-Quiet: 1` (only honoured together with `X-Actor`) suppresses the activity row for that request —
the bot uses it to keep the feed calm (~4 rows/min). Tasks created with `X-Actor` get ids prefixed
`td_` so the bot can prune only its own old done tasks (> 40) without touching user data.

## Errors

Non-2xx responses have the body `{ "error": { "code": DataErrorCode, "message": "<Korean>" } }`.

| HTTP | code | when |
|---|---|---|
| 400 | `invalid` | validation failed, unknown project/assignee/reassign target, bad actor |
| 404 | `not_found` | the task/member id in the URL does not exist |
| 409 | `conflict` | desk taken, team full, or a bot edit on something the manager touched in the last 2 min |
| 503 | `unavailable` | server shutting down / DB busy |
| 500 | `unavailable` | unexpected server error |

Unknown routes → `404 not_found`. Check order: bad actor (400) → missing id (404) → manager-touch
(409) → validation (400/409). `DELETE /api/members/:id` with neither `reassign` nor `reassignTo` →
`400` "작업 처리 방법을 선택해 주세요"; if both are given, `reassignTo` wins.

`ApiDataSource` maps these to `new DataError(message, code)`; network failures → `DataError('서버에 연결할 수 없어요', 'unavailable')`.

## Validation rules (same as the mock source)

- Task title: trimmed, 1–120 chars. `estimate ∈ {1,2,3,5,8}`. `priority`, `status` from the enums.
  `dueDate` `YYYY-MM-DD` or null. `projectId` must exist. `assigneeId` null or an existing member.
- Server assigns `id`, `number` (monotonic, never reused), `order` (top of the target stack when
  `assigneeId` changes and no `order` is given), `createdAt`, `updatedAt`.
- `status → 'done'` sets `completedAt`; leaving `done` clears it.
- Member name 1–30 chars, `capacity` 1–40, at most 10 members (`conflict` "자리가 모두 찼어요"),
  `deskId` must be one of `OFFICE.desks` and free (`conflict` "이미 사용 중인 자리예요"); omitted → first free.
- Deleting a member moves their open tasks per `reassign` (`backlog`: assignee null and
  in_progress/review → todo; `member`: to that member, must exist and differ) and sets
  `assigneeId = null` on their done tasks. Emits `task_upsert` for every moved task, then `member_delete`.
- Tasks have `onAgenda: boolean` (default false; missing in old data → false). Setting it true on a
  done task → `400` "완료된 작업은 안건으로 올릴 수 없어요". Completing a task clears it.
- Meetings (one meeting room → at most one `ongoing`):
  - start: `title` trimmed 1–60 chars ("회의 이름을 입력해 주세요"); `attendeeIds` ≥ 1, unique, existing
    ("참석자를 한 명 이상 골라 주세요" / unknown → `400`); another ongoing → `409` "이미 회의가 진행 중이에요".
    Captures open `onAgenda` tasks (ordered by priority weight desc, then number) as `agendaTaskIds`,
    sets each attendee's presence to `meeting`. Emits `member_upsert`×N, `meeting_upsert`, one
    `meeting_started` activity ("{title}을 시작했어요 · 참석 N명 · 안건 M건").
  - end: meeting must exist (`404`) and be ongoing (`409` "이미 끝난 회의예요"); `notes` ≤ 2000 chars;
    each outcome's `taskId` must be on that meeting's agenda and appear at most once; `assign`
    member must exist; `status` from the enum. Applies outcomes (`assign` → assignee + top of stack;
    `status` → status (done sets completedAt); `backlog` → assignee null, in_progress/review → todo;
    `keep` → nothing), clears `onAgenda` on every agenda task except `keep` ones and tasks deleted
    meanwhile (skipped silently), sets attendees still present back to `working`. One transaction.
    Emits `task_upsert`s, `member_upsert`s, `meeting_upsert`, one `meeting_ended` activity
    ("{title}이 끝났어요 · 결정 K건").
  - Clarifications (2026-10-07):
    - Start: validation (400) runs before the "already ongoing" 409. Emits `member_upsert` for every attendee.
    - End: only attendees whose presence is still `meeting` go back to `working` (someone the manager
      sent on a break stays there); `member_upsert` only for those that changed.
    - End: an outcome whose task **no longer exists** is skipped silently; an outcome for an existing
      task that is not on this meeting's agenda → `400` "안건에 없는 작업이에요".
    - `assign` moves the task to the top of the new stack only when the assignee actually changes.
    - "결정 K건" counts outcomes other than `keep`. Josa via `eul`/`iGa` from `src/data/mock/text.ts`.
    - Outcomes apply to the task as it is at end time, including a task completed during the meeting
      (a `status` outcome can reopen it). Outcomes whose task was deleted are dropped from
      `meeting.outcomes` and from the "결정 K건" count. An outcome that changes nothing (e.g. backlog
      for an already-unassigned todo) writes nothing, emits nothing, and does not bump `updatedAt`.
    - Demo/bot treat open `onAgenda` tasks as not free: they never take, start, move or complete them
      (the agenda belongs to the team lead).
    - Other messages: duplicate attendee "같은 참석자가 여러 번 들어 있어요"; duplicate outcome
      "같은 작업에 결정이 여러 개 있어요"; notes > 2000 "회의록은 2000자 이하로 입력해 주세요"; title > 60
      "회의 이름은 60자 이하로 입력해 주세요"; bad action "올바르지 않은 결정이에요"; non-boolean onAgenda
      "안건 값이 올바르지 않아요"; unknown meeting "회의를 찾을 수 없어요"; bot changing an attendee's
      presence during a meeting → 409 "회의 중인 팀원이라 지금은 바꿀 수 없어요".
  - Deleting a member removes them from an ongoing meeting's `attendeeIds`; deleting a task removes
    it from an ongoing meeting's `agendaTaskIds` (emit `meeting_upsert`).
  - While a meeting is ongoing, demo (bot / mock demo) must not change attendees' presence
    (`409` for the bot) and must not start an informal "meeting" of its own.
  - Workspace `meetings`: the ongoing one + the 20 most recent ended, newest last.
- Manager touch: any manager mutation of a task or member (any field) records a touch time. Bot (`X-Actor`)
  mutations of an entity touched by the manager in the last 120 s → `409 conflict`.

## Endpoints

| Method | Path | Body | 2xx response |
|---|---|---|---|
| GET | `/api/health` | – | `{ ok: true, version: 1 }` |
| GET | `/api/workspace` | – | `Workspace` (activity: newest last, ≤ 100) + header `X-Seq: <latest change seq>` |
| POST | `/api/tasks` | `TaskInput` | `201 Task` |
| PATCH | `/api/tasks/:id` | `TaskPatch` | `200 Task` |
| DELETE | `/api/tasks/:id` | – | `204` |
| POST | `/api/members` | `MemberInput` | `201 Member` |
| PATCH | `/api/members/:id` | `MemberPatch` | `200 Member` |
| DELETE | `/api/members/:id?reassign=backlog` or `?reassignTo=<memberId>` | – | `204` |
| GET | `/api/demo` | – | `{ on: boolean }` |
| PUT | `/api/demo` | `{ on: boolean }` | `{ on: boolean }` — persisted in `meta`, restored on boot, broadcast as a `demo` change |
| POST | `/api/meetings` | `MeetingStart` | `201 Meeting` |
| POST | `/api/meetings/:id/end` | `MeetingEnd` | `200 Meeting` |
| POST | `/api/reset` | `{}` | `Workspace` (reseeds; all clients get `snapshot`) |
| GET | `/api/events` | – | Server-Sent Events stream (below) |

Unknown fields in bodies are ignored. PATCH applies only the given fields.

Every successful mutation response carries `X-Seq: <seq of that mutation's last change>`. The client
uses it to tell whether the stream has already delivered something newer for the same entity (a
later edit or a delete by someone else); if so it resolves with the newer streamed state (or rejects
with `not_found` for a delete) instead of the stale response body.

## Change stream — `GET /api/events`

`text/event-stream`. Every mutation (from any client, the bot, or reset) produces one or more
`Change`s (see `src/data/types.ts`) — the same changes the mock source pushes, including one
`activity` change per meaningful action.

```
id: 1042
event: change
data: {"type":"task_upsert","task":{...}}
```

- `id` is a server-wide monotonic sequence number.
- On connect the server first sends `event: hello` with `data: {"seq": <latest>}`.
- Reconnect: the client sends `Last-Event-ID`. If the server still has every change after it
  (ring buffer of the last 1000), it replays them; otherwise it sends one
  `event: change` with `{"type":"snapshot","workspace":{...}}` and continues from there.
- Heartbeat: a `: ping` comment every 10 s. Clients treat 25 s of silence as a dead link.
- `POST /api/reset` broadcasts a `snapshot` change; `PUT /api/demo` broadcasts `{"type":"demo","on":…}`.
- `seq` is reserved and persisted inside the mutation's own transaction; broadcasting cannot fail
  a request after commit.

## Demo bot

Simulated teammates live **outside the core API**: `server/src/bot/` is a client that only talks
to the HTTP API (with `X-Actor`) — the same requests a real person's client would make. The server
process hosts one bot runner; `PUT /api/demo` starts/stops it. Behaviour mirrors the mock demo
(8–15 s ticks, same action weights, meeting/break returns, ≤ ~4 feed rows/min) and it treats
`409 conflict` as "skip this one". Demo state is server-wide: every tab sees the same office.

## Client (`ApiDataSource`)

- `load()` → `GET /api/workspace`; then opens the SSE stream from that `X-Seq`.
- Mutations → the endpoints above; resolve with the returned entity.
- `subscribe()` → forwards stream changes. Emits `{type:'connection', status}` on transitions:
  `connecting` (first attempt) → `online`; on loss → `offline`, and stays `offline` through retries
  until an attempt succeeds (no connecting/offline flicker). Reconnects with backoff (1 s → 10 s).
  Only a `text/event-stream` 2xx counts as connected. Any REST call failing as `unavailable`
  (network error, 502/503) aborts the current link so it reconnects immediately.
- `load()` never makes existing subscribers miss changes (a second `load()` keeps the stream and
  its position).
- `setDemoMode(on, reason)` → `PUT /api/demo` for `reason !== 'pause'`; if the request fails, emit
  `{type:'demo', on: <actual state from GET /api/demo, or the previous state>}` so the toggle never lies.
  After every reconnect (`online` again) re-read `GET /api/demo` and emit `demo` if it changed. Pauses are ignored: the
  demo is shared by every client, and the server's manager-touch rule already keeps the bot off
  whatever the user is editing.
- On load, read `GET /api/demo` and report it so the toggle shows the server's state (the store
  asks via `getDemoMode?()`).
- `reset()` → `POST /api/reset`.
- `label`: "로컬 서버".

Source selection (App.tsx): `?source=api` → `ApiDataSource`, otherwise `MockDataSource`.

The client reads the SSE stream with `fetch` + a stream reader (not `EventSource`), so it can send
`Last-Event-ID`/`X-Actor` headers and runs unchanged in Node for tests.

## Programmatic start (for tests and the CLI entry)

`server/src/app.ts` exports:

```ts
export interface ServerOptions {
  port?: number            // 0 = random free port; CLI default 8787
  dbPath?: string          // ':memory:' allowed; CLI default server/data/office.db
  demo?: boolean           // start the bot on boot; default false
  botTickMs?: [number, number] // bot tick range; default [8000, 15000]
  touchWindowMs?: number   // manager-touch protection window; default 120000
}
export function startServer(opts?: ServerOptions): Promise<{ url: string; close(): Promise<void> }>
```

`server/src/index.ts` is the CLI entry (`npm run server`): `startServer({ port: 8787 })` + logs the URL.
Contract tests (`tests/contract/`) start a server with `{ port: 0, dbPath: ':memory:' }` per suite and
run the same scenarios against `createApiDataSource({ baseUrl: url })` and `createMockDataSource(...)`.
