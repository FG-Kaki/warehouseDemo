// ApiDataSource client mechanics against a tiny fake server (independent of server/):
// SSE parsing, Last-Event-ID, reconnect + connection states, abort on unsubscribe, error mapping.
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { createApiDataSource } from '../../src/data/api'
import type { Change } from '../../src/data/types'
import { collect, rejectsWith } from './scenarios'

interface Fake {
  url: string
  server: Server
  streams: { lastEventId: string | undefined; res: ServerResponse; closed: boolean }[]
  demoBodies: string[]
  /** What the next /api/events connection does. */
  onStream: (res: ServerResponse, n: number) => void
  /** Overrides PATCH /api/tasks/:id (e.g. to hold the response back). */
  patch: ((res: ServerResponse) => void) | null
  demoState: boolean
  demoPutStatus: number
  demoGetStatus: number
  contentType: string
  /** Writes raw SSE text to every open stream. */
  push(text: string): void
  close(): Promise<void>
}

async function startFake(): Promise<Fake> {
  const fake: Fake = {
    url: '',
    server: null as unknown as Server,
    streams: [],
    demoBodies: [],
    onStream: () => {},
    patch: null,
    demoState: false,
    demoPutStatus: 200,
    demoGetStatus: 200,
    contentType: 'text/event-stream',
    push: (text) => {
      for (const st of fake.streams) if (!st.closed) st.res.write(text)
    },
    close: () => {
      fake.server.closeAllConnections()
      return new Promise((r) => fake.server.close(() => r()))
    },
  }
  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
    res.end(JSON.stringify(body))
  }
  fake.server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? ''
    if (url === '/api/workspace') return send(res, 200, { projects: [], members: [], tasks: [], activity: [] }, { 'x-seq': '5' })
    if (url === '/api/events') {
      const entry = { lastEventId: req.headers['last-event-id'] as string | undefined, res, closed: false }
      fake.streams.push(entry)
      res.on('close', () => (entry.closed = true))
      res.writeHead(200, { 'content-type': fake.contentType, 'cache-control': 'no-cache' })
      fake.onStream(res, fake.streams.length)
      return
    }
    if (url.startsWith('/api/tasks/') && req.method === 'PATCH' && fake.patch) return fake.patch(res)
    if (url.startsWith('/api/tasks/') && req.method === 'PATCH') return send(res, 409, { error: { code: 'conflict', message: '방금 수정한 작업이에요' } })
    if (url.startsWith('/api/tasks/') && req.method === 'DELETE') return send(res, 404, { error: { code: 'not_found', message: '작업을 찾을 수 없어요' } })
    if (url === '/api/tasks' && req.method === 'POST') return send(res, 400, { error: { code: 'invalid', message: '제목을 입력해 주세요' } })
    if (url === '/api/demo' && req.method === 'PUT') {
      let body = ''
      req.on('data', (d) => (body += d))
      req.on('end', () => {
        fake.demoBodies.push(body)
        if (fake.demoPutStatus !== 200) return send(res, fake.demoPutStatus, { error: { code: 'unavailable', message: '잠시 후 다시 해 주세요' } })
        fake.demoState = JSON.parse(body).on
        send(res, 200, { on: fake.demoState })
      })
      return
    }
    if (url === '/api/demo') {
      if (fake.demoGetStatus !== 200) return send(res, fake.demoGetStatus, { error: { code: 'unavailable', message: '잠시 후 다시 해 주세요' } })
      return send(res, 200, { on: fake.demoState })
    }
    if (url === '/api/boom') return send(res, 500, 'plain text')
    send(res, 404, { error: { code: 'not_found', message: '없어요' } })
  })
  await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', r))
  fake.url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`
  return fake
}

const task = { id: 't1', number: 1, title: 'x', description: '', status: 'todo', priority: 'medium', estimate: 3, projectId: 'p', assigneeId: null, dueDate: null, order: 1, createdAt: '', updatedAt: '', completedAt: null }
const sse = (id: number, change: Change) => `id: ${id}\nevent: change\ndata: ${JSON.stringify(change)}\n\n`

describe('ApiDataSource client mechanics', () => {
  it('maps error bodies to DataError(message, code) and network failures to unavailable', async () => {
    const fake = await startFake()
    try {
      const source = createApiDataSource({ baseUrl: fake.url })
      await rejectsWith(source.updateTask('t1', { title: 'x' }), 'conflict', '방금 수정한 작업이에요', '409')
      await rejectsWith(source.deleteTask('t1'), 'not_found', '작업을 찾을 수 없어요', '404')
      await rejectsWith(source.createTask({ title: '', projectId: 'p' }), 'invalid', '제목을 입력해 주세요', '400')
      source.close()
    } finally {
      await fake.close()
    }
    const dead = createApiDataSource({ baseUrl: fake.url }) // port is closed now
    await rejectsWith(dead.load(), 'unavailable', '서버에 연결할 수 없어요', 'closed port')
    await rejectsWith(dead.deleteTask('t1'), 'unavailable', '서버에 연결할 수 없어요', 'closed port (delete)')
    dead.close()
  })

  it('starts the stream from X-Seq, forwards changes, and reports connecting → online', async () => {
    const fake = await startFake()
    fake.onStream = (res) => {
      res.write('event: hello\ndata: {"seq":5}\n\n')
      res.write(': ping\n\n')
      res.write(sse(6, { type: 'task_upsert', task: task as never }))
      // split an event across two writes to exercise the parser
      const second = sse(7, { type: 'task_delete', id: 't1' })
      res.write(second.slice(0, 12))
      setTimeout(() => res.write(second.slice(12)), 20)
    }
    try {
      const source = createApiDataSource({ baseUrl: fake.url })
      const got: Change[] = []
      source.subscribe((c) => got.push(c)) // subscribe BEFORE load is fine
      await source.load()
      const t0 = Date.now()
      while (got.filter((c) => c.type !== 'connection').length < 2 && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10))
      assert.equal(fake.streams[0].lastEventId, '5', 'Last-Event-ID = X-Seq from /api/workspace')
      assert.deepEqual(got.map((c) => (c.type === 'connection' ? c.status : c.type)), ['connecting', 'online', 'task_upsert', 'task_delete'])
      source.close()
    } finally {
      await fake.close()
    }
  })

  it('reconnects with backoff, sends the last seen id, and goes offline in between', async () => {
    const fake = await startFake()
    fake.onStream = (res, n) => {
      res.write('event: hello\ndata: {"seq":5}\n\n')
      if (n === 1) {
        res.write(sse(6, { type: 'task_delete', id: 'a' }))
        setTimeout(() => res.end(), 30) // the link drops
      } else {
        res.write(sse(7, { type: 'task_delete', id: 'b' }))
      }
    }
    try {
      const source = createApiDataSource({ baseUrl: fake.url })
      const c = collect(source)
      await source.load()
      const t0 = Date.now()
      await c.until((x) => x.type === 'task_delete' && x.id === 'b', 'change after reconnect', 5000)
      const waited = Date.now() - t0
      assert.ok(waited >= 900, `backoff ~1 s before retrying (waited ${waited} ms)`)
      assert.equal(fake.streams.length, 2)
      assert.equal(fake.streams[1].lastEventId, '6', 'replay from the last seen id')
      assert.deepEqual(c.connections.slice(0, 5), ['connecting', 'online', 'offline', 'online'])
      c.off()
      source.close()
    } finally {
      await fake.close()
    }
  })

  it('unsubscribing the last listener aborts the stream; resubscribing resumes from the last id', async () => {
    const fake = await startFake()
    fake.onStream = (res) => {
      res.write('event: hello\ndata: {"seq":5}\n\n')
      res.write(sse(6, { type: 'task_delete', id: 'a' }))
    }
    try {
      const source = createApiDataSource({ baseUrl: fake.url })
      await source.load()
      const c1 = collect(source)
      await c1.until((x) => x.type === 'task_delete', 'first change')
      c1.off()
      const t0 = Date.now()
      while (!fake.streams[0].closed && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 10))
      assert.ok(fake.streams[0].closed, 'server saw the connection close')
      const c2 = collect(source)
      await c2.until((x) => x.type === 'task_delete', 'change again')
      assert.equal(fake.streams[1].lastEventId, '6')
      c2.off()
      source.close()
      const t1 = Date.now()
      while (!fake.streams[1].closed && Date.now() - t1 < 2000) await new Promise((r) => setTimeout(r, 10))
      assert.ok(fake.streams[1].closed, 'close() aborts the stream')
    } finally {
      await fake.close()
    }
  })

  it('demo: pause is ignored, user reaches the server; getDemoMode reads GET /api/demo', async () => {
    const fake = await startFake()
    try {
      const source = createApiDataSource({ baseUrl: fake.url })
      source.setDemoMode!(false, 'pause')
      source.setDemoMode!(true, 'pause')
      source.setDemoMode!(true, 'user')
      source.setDemoMode!(false)
      const t0 = Date.now()
      while (fake.demoBodies.length < 2 && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 10))
      assert.deepEqual(fake.demoBodies.map((b) => JSON.parse(b)), [{ on: true }, { on: false }])
      assert.equal(await source.getDemoMode!(), false, 'the last user toggle (off) is what the server holds')
      source.close()
    } finally {
      await fake.close()
    }
  })

  it('a stream that cannot connect reports offline and keeps retrying', async () => {
    const fake = await startFake()
    fake.onStream = (res) => res.destroy()
    try {
      const source = createApiDataSource({ baseUrl: fake.url })
      const c = collect(source)
      await source.load()
      const t0 = Date.now()
      while (!c.connections.includes('offline') && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10))
      assert.ok(c.connections.includes('offline'))
      assert.equal(c.connections.at(-1) === 'online', false)
      await new Promise((r) => setTimeout(r, 1300)) // a second attempt happens after the 1 s backoff
      assert.ok(fake.streams.length >= 2, 'retried')
      assert.deepEqual(c.connections, ['connecting', 'offline'], 'no connecting/offline flicker between retries')
      c.off()
      source.close()
    } finally {
      await fake.close()
    }
  })

  // ---- stale REST responses vs the stream -------------------------------------------------

  const held = (fake: Fake) => {
    let resolveHeld: (res: ServerResponse) => void = () => {}
    const promise = new Promise<ServerResponse>((r) => (resolveHeld = r))
    fake.patch = (res) => resolveHeld(res)
    return promise
  }
  const respond = (res: ServerResponse, seq: number, entity: unknown) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'x-seq': String(seq) })
    res.end(JSON.stringify(entity))
  }
  const online = async (c: { connections: string[] }) => {
    const t0 = Date.now()
    while (!c.connections.includes('online') && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10))
    assert.ok(c.connections.includes('online'), 'stream online')
  }
  const idle = (res: ServerResponse) => res.write('event: hello\ndata: {"seq":5}\n\n')

  it('stale PATCH response vs a newer streamed update: resolves with the streamed entity', async () => {
    const fake = await startFake()
    fake.onStream = idle
    try {
      const source = createApiDataSource({ baseUrl: fake.url })
      await source.load()
      const c = collect(source)
      const holdPromise = held(fake)
      const pending = source.updateTask('t1', { title: 'older' })
      const res = await holdPromise
      fake.push(sse(10, { type: 'task_upsert', task: { ...task, title: 'newer' } as never }))
      await c.until((x) => x.type === 'task_upsert', 'streamed upsert')
      respond(res, 8, { ...task, title: 'older' })
      assert.equal((await pending).title, 'newer', 'the stream already had something newer')
      // a response that is NOT behind the stream is returned as is
      const holdAgain = held(fake)
      const second = source.updateTask('t1', { title: 'fresh' })
      respond(await holdAgain, 12, { ...task, title: 'fresh' })
      assert.equal((await second).title, 'fresh')
      c.off()
      source.close()
    } finally {
      await fake.close()
    }
  })

  it('stale PATCH response vs a streamed delete: rejects not_found (no ghost)', async () => {
    const fake = await startFake()
    fake.onStream = idle
    try {
      const source = createApiDataSource({ baseUrl: fake.url })
      await source.load()
      const c = collect(source)
      const holdPromise = held(fake)
      const pending = source.updateTask('t1', { title: 'older' })
      const res = await holdPromise
      fake.push(sse(10, { type: 'task_delete', id: 't1' }))
      await c.until((x) => x.type === 'task_delete', 'streamed delete')
      respond(res, 8, { ...task, title: 'older' })
      await rejectsWith(pending, 'not_found', '작업을 찾을 수 없어요', 'update after a remote delete')
      c.off()
      source.close()
    } finally {
      await fake.close()
    }
  })

  it('the stale-response memory is bounded', async () => {
    const fake = await startFake()
    fake.onStream = idle
    try {
      const source = createApiDataSource({ baseUrl: fake.url })
      await source.load()
      const c = collect(source)
      await online(c)
      // 1000 streamed deletes of different tasks: only the most recent ones are remembered
      for (let i = 0; i < 1000; i++) fake.push(sse(10 + i, { type: 'task_delete', id: `x${i}` }))
      await c.until((x) => x.type === 'task_delete' && x.id === 'x999', 'last delete', 5000)
      // x0 was evicted: a response for it with an older seq is taken at face value
      const holdPromise = held(fake)
      const pending = source.updateTask('x0', { title: 'ok' })
      respond(await holdPromise, 8, { ...task, id: 'x0', title: 'ok' })
      assert.equal((await pending).title, 'ok')
      // x999 is remembered: the same situation is rejected
      const holdAgain = held(fake)
      const pending2 = source.updateTask('x999', { title: 'ok' })
      respond(await holdAgain, 8, { ...task, id: 'x999', title: 'ok' })
      await rejectsWith(pending2, 'not_found', '작업을 찾을 수 없어요', 'recent delete')
      c.off()
      source.close()
    } finally {
      await fake.close()
    }
  })

  // ---- demo state ----------------------------------------------------------------------------

  it('a failed PUT /api/demo re-reads the server state and emits a demo change', async () => {
    const fake = await startFake()
    fake.demoState = true
    fake.demoPutStatus = 503
    try {
      const source = createApiDataSource({ baseUrl: fake.url })
      const got: Change[] = []
      source.subscribe((x) => got.push(x))
      await source.load()
      assert.equal(await source.getDemoMode!(), true)
      source.setDemoMode!(false, 'user')
      const t0 = Date.now()
      while (!got.some((x) => x.type === 'demo') && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 10))
      assert.deepEqual(got.find((x) => x.type === 'demo'), { type: 'demo', on: true }, 'the toggle snaps back to the real state')
      // GET fails too: fall back to the previous state
      fake.demoGetStatus = 503
      got.length = 0
      source.setDemoMode!(false, 'user')
      const t1 = Date.now()
      while (!got.some((x) => x.type === 'demo') && Date.now() - t1 < 2000) await new Promise((r) => setTimeout(r, 10))
      assert.deepEqual(got.find((x) => x.type === 'demo'), { type: 'demo', on: true }, 'previous state when the server cannot be asked')
      source.close()
    } finally {
      await fake.close()
    }
  })

  it('a streamed demo change is forwarded; after a reconnect the demo state is re-read', async () => {
    const fake = await startFake()
    fake.demoState = true
    fake.onStream = (res, n) => {
      res.write('event: hello\ndata: {"seq":5}\n\n')
      if (n === 1) {
        res.write(sse(6, { type: 'demo', on: true }))
        setTimeout(() => {
          fake.demoState = false // toggled while the link is down
          res.end()
        }, 30)
      }
    }
    try {
      const source = createApiDataSource({ baseUrl: fake.url })
      const c = collect(source)
      await source.load()
      await source.getDemoMode!()
      await c.until((x) => x.type === 'demo' && x.on === true, 'streamed demo change')
      await c.until((x) => x.type === 'demo' && x.on === false, 'demo state re-read after the reconnect', 5000)
      c.off()
      source.close()
    } finally {
      await fake.close()
    }
  })

  // ---- robustness ----------------------------------------------------------------------------------

  it('only a 2xx text/event-stream counts as online', async () => {
    const fake = await startFake()
    fake.contentType = 'text/html'
    fake.onStream = (res) => res.end('<html>login portal</html>')
    try {
      const source = createApiDataSource({ baseUrl: fake.url })
      const c = collect(source)
      await source.load()
      await new Promise((r) => setTimeout(r, 300))
      assert.ok(!c.connections.includes('online'), 'an HTML page is not a stream')
      assert.ok(c.connections.includes('offline'))
      c.off()
      source.close()
    } finally {
      await fake.close()
    }
  })

  it('a REST call failing as unavailable cuts the link and reconnects immediately', async () => {
    const fake = await startFake()
    fake.onStream = idle
    fake.patch = (res) => {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'unavailable', message: '잠시 후 다시 해 주세요' } }))
    }
    try {
      const source = createApiDataSource({ baseUrl: fake.url })
      const c = collect(source)
      await source.load()
      await online(c)
      const t0 = Date.now()
      await rejectsWith(source.updateTask('t1', { title: 'x' }), 'unavailable', '잠시 후 다시 해 주세요', '503')
      while (fake.streams.length < 2 && Date.now() - t0 < 900) await new Promise((r) => setTimeout(r, 10))
      assert.equal(fake.streams.length, 2, 'reconnected well before the 1 s backoff')
      assert.ok(Date.now() - t0 < 900)
      assert.ok(fake.streams[0].closed, 'old link was cut')
      c.off()
      source.close()
    } finally {
      await fake.close()
    }
  })

  // ---- a store-like consumer ------------------------------------------------------------------------

  it('a reconnect snapshot, applied by a minimal store-like consumer, replaces state and continues', async () => {
    const fake = await startFake()
    const t = (id: string) => ({ ...task, id }) as never
    fake.onStream = (res, n) => {
      res.write('event: hello\ndata: {"seq":5}\n\n')
      if (n === 1) {
        res.write(sse(6, { type: 'task_upsert', task: t('t1') }))
        setTimeout(() => res.end(), 30)
      } else {
        // the server could not replay: one snapshot, then business as usual
        res.write(sse(20, { type: 'snapshot', workspace: { projects: [], members: [], tasks: [t('t2')], meetings: [], activity: [] } }))
        res.write(sse(21, { type: 'task_upsert', task: t('t3') }))
      }
    }
    try {
      const source = createApiDataSource({ baseUrl: fake.url })
      const tasks = new Map<string, unknown>()
      const apply = (ch: Change) => {
        if (ch.type === 'task_upsert') tasks.set(ch.task.id, ch.task)
        else if (ch.type === 'task_delete') tasks.delete(ch.id)
        else if (ch.type === 'snapshot') {
          tasks.clear()
          for (const x of ch.workspace.tasks) tasks.set(x.id, x)
        }
      }
      const ws = await source.load()
      for (const x of ws.tasks) tasks.set(x.id, x)
      source.subscribe(apply)
      const t0 = Date.now()
      while (!tasks.has('t3') && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 10))
      assert.deepEqual([...tasks.keys()].sort(), ['t2', 't3'], 't1 is gone after the snapshot')
      assert.equal(fake.streams[1].lastEventId, '6')
      source.close()
    } finally {
      await fake.close()
    }
  })

  it('load() while subscribed keeps the stream and its position', async () => {
    const fake = await startFake()
    fake.onStream = idle
    try {
      const source = createApiDataSource({ baseUrl: fake.url })
      const c = collect(source)
      await source.load()
      await online(c)
      fake.push(sse(6, { type: 'task_delete', id: 'a' }))
      await c.until((x) => x.type === 'task_delete' && x.id === 'a', 'first change')
      await source.load() // e.g. the store retrying
      assert.equal(fake.streams.length, 1, 'no new stream')
      assert.ok(!fake.streams[0].closed)
      fake.push(sse(7, { type: 'task_delete', id: 'b' }))
      await c.until((x) => x.type === 'task_delete' && x.id === 'b', 'change after the second load')
      assert.deepEqual(c.connections, ['connecting', 'online'])
      c.off()
      source.close()
    } finally {
      await fake.close()
    }
  })

  it('reset sends a JSON body', async () => {
    const fake = await startFake()
    let seen = ''
    fake.server.on('request', (req) => {
      if (req.url === '/api/reset') seen = `${req.headers['content-type']}`
    })
    try {
      const source = createApiDataSource({ baseUrl: fake.url })
      await source.reset!().catch(() => {}) // the fake answers 404; only the request matters
      assert.match(seen, /application\/json/)
      source.close()
    } finally {
      await fake.close()
    }
  })
})
