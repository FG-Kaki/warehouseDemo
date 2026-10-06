// OWNER: data-engineer. DataSource backed by the local server (docs/API.md).
// REST via fetch; changes via an SSE stream read with fetch + ReadableStream (so it runs in Node
// tests and can send Last-Event-ID). The stream runs while there is at least one subscriber and
// the workspace has been loaded; it reconnects with backoff and replays from the last seen id.
import { DataError, type DataErrorCode, type DataSource } from '../DataSource'
import type { Change, ConnectionStatus, Id, Member, MemberInput, MemberPatch, Reassign, Task, TaskInput, TaskPatch, Workspace } from '../types'
import { createSseParser } from './sse'

export interface ApiOptions {
  /** Base URL of the API, default '' (same origin; Vite proxies /api in dev). */
  baseUrl?: string
}

/** The DataSource plus an explicit teardown (tests, hot reload). */
export type ApiDataSource = DataSource & { close(): void }

const BACKOFF_START_MS = 1000
const BACKOFF_MAX_MS = 10_000
/** The server pings every 10 s; this much silence means the link is dead. */
const IDLE_LIMIT_MS = 25_000
/** How many streamed task/member positions are remembered for stale-response detection. */
const STREAMED_MAX = 600

const CODES: DataErrorCode[] = ['invalid', 'not_found', 'conflict', 'unavailable']
const UNREACHABLE = '서버에 연결할 수 없어요'

function codeForStatus(status: number): DataErrorCode {
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status >= 500) return 'unavailable'
  return 'invalid'
}

async function toError(res: Response): Promise<DataError> {
  try {
    const body: unknown = await res.json()
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const e = (body as { error: unknown }).error
      if (typeof e === 'object' && e !== null) {
        const { code, message } = e as { code?: unknown; message?: unknown }
        const known = CODES.includes(code as DataErrorCode) ? (code as DataErrorCode) : codeForStatus(res.status)
        return new DataError(typeof message === 'string' && message ? message : '요청을 처리하지 못했어요', known)
      }
    }
  } catch {
    // not JSON
  }
  return new DataError(res.status >= 500 ? '서버에서 문제가 생겼어요' : '요청을 처리하지 못했어요', codeForStatus(res.status))
}

type EntityKind = 'task' | 'member'

export function createApiDataSource(opts: ApiOptions = {}): ApiDataSource {
  const base = (opts.baseUrl ?? '').replace(/\/+$/, '')
  const listeners = new Set<(c: Change) => void>()

  let loaded = false
  /** Stream position: id of the last change delivered (or the X-Seq of the loaded workspace). */
  let lastSeq = 0
  let status: ConnectionStatus | null = null
  let session: AbortController | null = null
  /** The live HTTP link of the running stream, so a failing REST call can cut it. */
  let currentLink: AbortController | null = null
  let retryNow = false
  /** Last known server-side demo state (null = never read). */
  let demoOn: boolean | null = null
  /**
   * Latest streamed state per entity with its seq (null entity = deleted). A REST response whose
   * X-Seq is not newer than this is stale: the stream already delivered something later.
   */
  const streamed = new Map<string, { seq: number; entity: Task | Member | null }>()

  const remember = (key: string, seq: number, entity: Task | Member | null) => {
    streamed.delete(key)
    streamed.set(key, { seq, entity })
    if (streamed.size > STREAMED_MAX) {
      const oldest = streamed.keys().next().value
      if (oldest !== undefined) streamed.delete(oldest)
    }
  }

  // ---- REST ------------------------------------------------------------------

  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    let res: Response
    try {
      res = await fetch(base + path, {
        method,
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch {
      cutLink()
      throw new DataError(UNREACHABLE, 'unavailable')
    }
    if (!res.ok) {
      const err = await toError(res)
      if (err.code === 'unavailable') cutLink()
      throw err
    }
    return res
  }

  /** REST says the server is unavailable: drop the stream link so it reconnects at once. */
  function cutLink() {
    if (!currentLink) return
    retryNow = true
    currentLink.abort()
  }

  async function body<T>(res: Response): Promise<T> {
    try {
      return (await res.json()) as T
    } catch {
      throw new DataError('서버 응답을 읽을 수 없어요', 'unavailable')
    }
  }

  const json = async <T>(method: string, path: string, payload?: unknown): Promise<T> => body<T>(await send(method, path, payload))

  /** Runs a task/member mutation and resolves with the newest known state of that entity. */
  async function mutate<T extends Task | Member>(kind: EntityKind, method: string, path: string, payload: unknown): Promise<T> {
    const res = await send(method, path, payload)
    const entity = await body<T>(res)
    const header = res.headers.get('X-Seq')
    const seq = header === null ? NaN : Number(header)
    if (Number.isFinite(seq)) {
      const rec = streamed.get(`${kind}:${entity.id}`)
      if (rec && rec.seq >= seq) {
        if (rec.entity === null) throw new DataError(kind === 'task' ? '작업을 찾을 수 없어요' : '팀원을 찾을 수 없어요', 'not_found')
        return structuredClone(rec.entity) as T
      }
    }
    return entity
  }

  // ---- change stream -----------------------------------------------------------

  function emit(change: Change) {
    for (const l of [...listeners]) {
      try {
        l(change)
      } catch (e) {
        console.error('api data source: listener failed', e)
      }
    }
  }

  function setStatus(next: ConnectionStatus) {
    if (status === next) return
    status = next
    emit({ type: 'connection', status: next })
  }

  async function readDemo(): Promise<boolean | null> {
    try {
      const b = await json<{ on?: unknown }>('GET', '/api/demo')
      return b.on === true
    } catch {
      return null
    }
  }

  /** After a reconnect the demo may have been toggled meanwhile: re-read it and tell the store if it changed. */
  async function refreshDemo() {
    const on = await readDemo()
    if (on === null || on === demoOn) return
    demoOn = on
    emit({ type: 'demo', on })
  }

  function onChange(change: Change, seq: number | null) {
    if (seq !== null) {
      if (change.type === 'task_upsert') remember(`task:${change.task.id}`, seq, change.task)
      else if (change.type === 'task_delete') remember(`task:${change.id}`, seq, null)
      else if (change.type === 'member_upsert') remember(`member:${change.member.id}`, seq, change.member)
      else if (change.type === 'member_delete') remember(`member:${change.id}`, seq, null)
    }
    if (change.type === 'snapshot') streamed.clear()
    if (change.type === 'demo') demoOn = change.on
    emit(change)
  }

  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(done, ms)
      signal.addEventListener('abort', done, { once: true })
      function done() {
        clearTimeout(t)
        signal.removeEventListener('abort', done)
        resolve()
      }
    })

  async function runStream(signal: AbortSignal) {
    let backoff = BACKOFF_START_MS
    let wasOffline = false
    while (!signal.aborted) {
      // 'connecting' only for the very first attempt; after a loss we stay 'offline' until one succeeds
      if (status === null) setStatus('connecting')
      const link = new AbortController()
      currentLink = link
      const abortLink = () => link.abort()
      signal.addEventListener('abort', abortLink, { once: true })
      let idle: ReturnType<typeof setTimeout> | null = null
      const touchIdle = () => {
        if (idle !== null) clearTimeout(idle)
        idle = setTimeout(() => link.abort(), IDLE_LIMIT_MS)
      }
      try {
        const res = await fetch(`${base}/api/events`, {
          headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache', 'Last-Event-ID': String(lastSeq) },
          signal: link.signal,
        })
        const type = res.headers.get('content-type') ?? ''
        if (!res.ok || !res.body || !type.toLowerCase().includes('text/event-stream')) {
          await res.body?.cancel().catch(() => {})
          throw new Error(`events ${res.status}`)
        }
        setStatus('online')
        if (wasOffline) {
          wasOffline = false
          void refreshDemo()
        }
        touchIdle()
        const parser = createSseParser(
          (e) => {
            if (e.event === 'hello') {
              backoff = BACKOFF_START_MS
              return
            }
            if (e.event !== 'change') return
            let change: Change
            try {
              change = JSON.parse(e.data) as Change
            } catch {
              return
            }
            let seq: number | null = null
            if (e.id !== undefined) {
              const n = Number(e.id)
              if (Number.isFinite(n)) {
                seq = n
                lastSeq = n
              }
            }
            onChange(change, seq)
          },
          () => touchIdle(),
        )
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (link.signal.aborted) break
          touchIdle()
          parser.push(decoder.decode(value, { stream: true }))
        }
      } catch {
        // dropped / aborted / refused: fall through to the retry logic
      } finally {
        if (idle !== null) clearTimeout(idle)
        signal.removeEventListener('abort', abortLink)
        if (currentLink === link) currentLink = null
      }
      if (signal.aborted) return
      setStatus('offline')
      wasOffline = true
      if (retryNow) {
        retryNow = false // a REST failure cut a healthy link: try again right away
        continue
      }
      await sleep(backoff, signal)
      backoff = Math.min(BACKOFF_MAX_MS, backoff * 2)
    }
  }

  /** Runs the stream while the workspace is loaded and somebody listens. */
  function sync() {
    const want = loaded && listeners.size > 0
    if (want && !session) {
      const controller = new AbortController()
      session = controller
      retryNow = false
      void runStream(controller.signal).finally(() => {
        if (session === controller) session = null
      })
    } else if (!want && session) {
      session.abort()
      session = null
      currentLink = null
      status = null
    }
  }

  // ---- DataSource --------------------------------------------------------------

  const source: ApiDataSource = {
    label: '로컬 서버',

    async load() {
      const res = await send('GET', '/api/workspace')
      const ws = await body<Workspace>(res)
      const seq = Number(res.headers.get('X-Seq'))
      if (!session) {
        // a running stream keeps its own position (never drop changes for existing listeners)
        lastSeq = Number.isFinite(seq) ? seq : 0
        streamed.clear()
      }
      loaded = true
      sync()
      return ws
    },

    createTask: (input: TaskInput) => mutate<Task>('task', 'POST', '/api/tasks', input),
    updateTask: (id: Id, patch: TaskPatch) => mutate<Task>('task', 'PATCH', `/api/tasks/${encodeURIComponent(id)}`, patch),
    async deleteTask(id) {
      await send('DELETE', `/api/tasks/${encodeURIComponent(id)}`)
    },

    createMember: (input: MemberInput) => mutate<Member>('member', 'POST', '/api/members', input),
    updateMember: (id: Id, patch: MemberPatch) => mutate<Member>('member', 'PATCH', `/api/members/${encodeURIComponent(id)}`, patch),
    async deleteMember(id, reassign: Reassign) {
      const q = reassign.mode === 'member' ? `reassignTo=${encodeURIComponent(reassign.memberId)}` : 'reassign=backlog'
      await send('DELETE', `/api/members/${encodeURIComponent(id)}?${q}`)
    },

    subscribe(listener) {
      listeners.add(listener)
      if (session && status) listener({ type: 'connection', status })
      sync()
      return () => {
        listeners.delete(listener)
        sync()
      }
    },

    setDemoMode(on, reason) {
      // The demo is shared by every client; brief pauses (dialog / drag) are the server's business.
      if (reason === 'pause') return
      const previous = demoOn
      void (async () => {
        try {
          const r = await json<{ on?: unknown }>('PUT', '/api/demo', { on })
          demoOn = r.on === true
        } catch {
          // The toggle must not lie: report what the server actually says (or what it was before).
          const actual = (await readDemo()) ?? previous ?? !on
          demoOn = actual
          emit({ type: 'demo', on: actual })
        }
      })()
    },

    async getDemoMode() {
      const on = await readDemo()
      if (on !== null) demoOn = on
      return on === true
    },

    reset: () => json<Workspace>('POST', '/api/reset', {}),

    close() {
      listeners.clear()
      loaded = false
      if (session) session.abort()
      session = null
      currentLink = null
      status = null
      streamed.clear()
    },
  }
  return source
}
