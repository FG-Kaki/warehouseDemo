// Contract suite against the API source + the real server (in-memory SQLite, random port),
// plus scenarios that only make sense over HTTP: multi-client SSE, Last-Event-ID replay, bot actor rules.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApiDataSource } from '../../src/data/api'
import { createSseParser } from '../../src/data/api/sse'
import type { Change, Task, Workspace } from '../../src/data/types'
import { collect, defineContractSuite, rejectsWith } from './scenarios'

const appPath = fileURLToPath(new URL('../../server/src/app.ts', import.meta.url))
const serverExists = existsSync(appPath)

interface Running {
  url: string
  close(): Promise<void>
}
type StartServer = (opts?: { port?: number; dbPath?: string; demo?: boolean; botTickMs?: [number, number]; touchWindowMs?: number }) => Promise<Running>

async function loadStartServer(): Promise<StartServer> {
  const spec = '../../server/src/app.ts' // variable specifier: the file may not exist yet
  const mod = (await import(spec)) as { startServer: StartServer }
  return mod.startServer
}

const reseed = (url: string) =>
  fetch(`${url}/api/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => assert.equal(r.status, 200, 'reset'))

if (!serverExists) {
  describe('contract: api', { skip: 'server/src/app.ts does not exist yet' }, () => {
    it('pending', () => {})
  })
} else {
  // ---- shared scenarios ------------------------------------------------------------
  let shared: Running
  before(async () => {
    shared = await (await loadStartServer())({ port: 0, dbPath: ':memory:' })
  })
  after(async () => {
    await shared.close()
  })

  defineContractSuite('api', async () => {
    await reseed(shared.url)
    const source = createApiDataSource({ baseUrl: shared.url })
    return { source, dispose: () => source.close() }
  })

  // ---- API only ----------------------------------------------------------------------
  describe('api only', () => {
    const open = async () => {
      await reseed(shared.url)
      const source = createApiDataSource({ baseUrl: shared.url })
      const ws = await source.load()
      return { source, ws }
    }

    it('health and workspace headers', async () => {
      const health = await (await fetch(`${shared.url}/api/health`)).json()
      assert.deepEqual(health, { ok: true, version: 1 })
      const res = await fetch(`${shared.url}/api/workspace`)
      assert.equal(res.status, 200)
      assert.match(res.headers.get('x-seq') ?? '', /^\d+$/)
    })

    it('error bodies are { error: { code, message } } with matching HTTP status', async () => {
      const r404 = await fetch(`${shared.url}/api/tasks/nope`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' })
      assert.equal(r404.status, 404)
      const body = (await r404.json()) as { error: { code: string; message: string } }
      assert.equal(body.error.code, 'not_found')
      assert.equal(typeof body.error.message, 'string')
      const r400 = await fetch(`${shared.url}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '' }) })
      assert.equal(r400.status, 400)
      assert.equal(((await r400.json()) as { error: { code: string } }).error.code, 'invalid')
    })

    it('network failure maps to DataError unavailable', async () => {
      const dead = createApiDataSource({ baseUrl: 'http://127.0.0.1:1' })
      await rejectsWith(dead.load(), 'unavailable', '서버에 연결할 수 없어요', 'load on a dead port')
      await rejectsWith(dead.createTask({ title: 'x', projectId: 'p' }), 'unavailable', '서버에 연결할 수 없어요', 'create on a dead port')
      dead.close()
    })

    it('a second client sees the first client’s changes via SSE', async () => {
      const a = await open()
      const b = createApiDataSource({ baseUrl: shared.url })
      await b.load()
      const cb = collect(b)
      const t = await a.source.createTask({ title: '다른 클라이언트에서 만든 작업', projectId: a.ws.projects[0].id, assigneeId: a.ws.members[0].id })
      await cb.until((c) => c.type === 'task_upsert' && c.task.id === t.id, 'B gets the upsert')
      await cb.until((c) => c.type === 'activity' && c.activity.taskId === t.id, 'B gets the activity')
      await a.source.updateTask(t.id, { status: 'done' })
      await cb.until((c) => c.type === 'task_upsert' && c.task.id === t.id && c.task.status === 'done', 'B sees the completion')
      await a.source.deleteTask(t.id)
      await cb.until((c) => c.type === 'task_delete' && c.id === t.id, 'B sees the delete')
      assert.ok(cb.connections.includes('online'), 'B reported online')
      cb.off()
      a.source.close()
      b.close()
    })

    it('a snapshot reaches every client after reset', async () => {
      const a = await open()
      const b = createApiDataSource({ baseUrl: shared.url })
      await b.load()
      const cb = collect(b)
      await a.source.createTask({ title: '리셋 전', projectId: a.ws.projects[0].id })
      await cb.until((c) => c.type === 'task_upsert', 'B sees the new task')
      await a.source.reset!()
      const snap = (await cb.until((c) => c.type === 'snapshot', 'B gets a snapshot')) as Extract<Change, { type: 'snapshot' }>
      assert.equal(snap.workspace.tasks.length, 36)
      cb.off()
      a.source.close()
      b.close()
    })

    it('subscribing after load replays changes made in between (starts from X-Seq)', async () => {
      const a = await open()
      const b = createApiDataSource({ baseUrl: shared.url })
      await b.load() // not subscribed yet
      const t1 = await a.source.createTask({ title: '놓친 변경 1', projectId: a.ws.projects[0].id })
      const t2 = await a.source.createTask({ title: '놓친 변경 2', projectId: a.ws.projects[0].id })
      const cb = collect(b)
      await cb.until((c) => c.type === 'task_upsert' && c.task.id === t1.id, 'replayed #1')
      await cb.until((c) => c.type === 'task_upsert' && c.task.id === t2.id, 'replayed #2')
      cb.off()
      a.source.close()
      b.close()
    })

    it('Last-Event-ID replays everything after that id, in order', async () => {
      const a = await open()
      const res0 = await fetch(`${shared.url}/api/workspace`)
      const seq = Number(res0.headers.get('x-seq'))
      await res0.arrayBuffer()
      const made: Task[] = []
      for (let i = 0; i < 3; i++) made.push(await a.source.createTask({ title: `재생 ${i}`, projectId: a.ws.projects[1].id }))
      const ids: number[] = []
      const seen: Change[] = []
      let sawHello = false
      const ctl = new AbortController()
      const res = await fetch(`${shared.url}/api/events`, { headers: { 'Last-Event-ID': String(seq), Accept: 'text/event-stream' }, signal: ctl.signal })
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
      const parser = createSseParser((e) => {
        if (e.event === 'hello') sawHello = true
        if (e.event === 'change') {
          ids.push(Number(e.id))
          seen.push(JSON.parse(e.data) as Change)
        }
      })
      const reader = res.body!.getReader()
      const dec = new TextDecoder()
      const deadline = Date.now() + 4000
      while (Date.now() < deadline && !made.every((t) => seen.some((c) => c.type === 'task_upsert' && c.task.id === t.id))) {
        const { value, done } = await reader.read()
        if (done) break
        parser.push(dec.decode(value, { stream: true }))
      }
      ctl.abort()
      assert.ok(sawHello, 'hello event')
      assert.ok(ids.every((id) => id > seq), 'only changes after Last-Event-ID')
      assert.deepEqual([...ids], [...ids].sort((x, y) => x - y), 'ascending ids')
      const order = made.map((t) => seen.findIndex((c) => c.type === 'task_upsert' && c.task.id === t.id))
      assert.ok(order.every((i) => i >= 0), 'all three replayed')
      assert.deepEqual(order, [...order].sort((x, y) => x - y), 'replayed in order')
      a.source.close()
    })

    it('a Last-Event-ID the server cannot replay yields a snapshot', async () => {
      await reseed(shared.url)
      const ctl = new AbortController()
      const res = await fetch(`${shared.url}/api/events`, { headers: { 'Last-Event-ID': '999999999', Accept: 'text/event-stream' }, signal: ctl.signal })
      let first: Change | null = null
      const parser = createSseParser((e) => {
        if (e.event === 'change' && !first) first = JSON.parse(e.data) as Change
      })
      const reader = res.body!.getReader()
      const dec = new TextDecoder()
      const deadline = Date.now() + 3000
      while (Date.now() < deadline && !first) {
        const { value, done } = await reader.read()
        if (done) break
        parser.push(dec.decode(value, { stream: true }))
      }
      ctl.abort()
      assert.equal((first as Change | null)?.type, 'snapshot')
      assert.equal(((first as unknown as { workspace: Workspace }).workspace.tasks as Task[]).length, 36)
    })

    it('bot (X-Actor) edits of manager-touched entities get 409; unknown actors 400', async () => {
      const a = await open()
      const task = a.ws.tasks.find((t) => t.status === 'todo' && t.assigneeId !== null)!
      const bot = a.ws.members[0].id
      const patch = (headers: Record<string, string>, body: unknown) =>
        fetch(`${shared.url}/api/tasks/${task.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

      // untouched by the manager (seed): the bot may edit
      const ok = await patch({ 'x-actor': bot }, { status: 'in_progress' })
      assert.equal(ok.status, 200, 'bot edits an untouched task')
      const activity = ((await (await fetch(`${shared.url}/api/workspace`)).json()) as Workspace).activity.at(-1)!
      assert.equal(activity.actorId, bot, 'activity carries the bot actor')

      // the manager touches it, the bot is locked out for the window
      await a.source.updateTask(task.id, { priority: 'urgent' })
      const blocked = await patch({ 'x-actor': bot }, { status: 'review' })
      assert.equal(blocked.status, 409)
      const body = (await blocked.json()) as { error: { code: string } }
      assert.equal(body.error.code, 'conflict')
      const stillThere = (await a.source.load()).tasks.find((t) => t.id === task.id)!
      assert.equal(stillThere.status, 'in_progress', 'the blocked edit changed nothing')

      // the manager is never blocked, and an unknown actor is rejected
      const mgr = await patch({}, { status: 'review' })
      assert.equal(mgr.status, 200)
      const ghost = await patch({ 'x-actor': 'ghost' }, { status: 'todo' })
      assert.equal(ghost.status, 400)
      assert.equal(((await ghost.json()) as { error: { code: string } }).error.code, 'invalid')
      a.source.close()
    })

    it('the manager-touch window expires', async () => {
      const server = await (await loadStartServer())({ port: 0, dbPath: ':memory:', touchWindowMs: 250 })
      try {
        const source = createApiDataSource({ baseUrl: server.url })
        const ws = await source.load()
        const task = ws.tasks.find((t) => t.status === 'todo' && t.assigneeId !== null)!
        const bot = ws.members[0].id
        await source.updateTask(task.id, { priority: 'low' })
        const patch = () =>
          fetch(`${server.url}/api/tasks/${task.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-actor': bot }, body: JSON.stringify({ status: 'in_progress' }) })
        assert.equal((await patch()).status, 409)
        await new Promise((r) => setTimeout(r, 400))
        assert.equal((await patch()).status, 200)
        source.close()
      } finally {
        await server.close()
      }
    })

    it('demo endpoints round-trip', async () => {
      const source = createApiDataSource({ baseUrl: shared.url })
      assert.equal(await source.getDemoMode!(), false)
      const put = await fetch(`${shared.url}/api/demo`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: false }) })
      assert.deepEqual(await put.json(), { on: false })
      source.setDemoMode!(true, 'pause') // ignored
      await new Promise((r) => setTimeout(r, 100))
      assert.equal(await source.getDemoMode!(), false, "'pause' does not reach the server")
      source.close()
    })

    it('a demo toggle is broadcast to every client', async () => {
      const a = createApiDataSource({ baseUrl: shared.url })
      const b = createApiDataSource({ baseUrl: shared.url })
      await a.load()
      await b.load()
      const cb = collect(b)
      const ca = collect(a)
      a.setDemoMode!(true, 'user')
      await cb.until((c) => c.type === 'demo' && c.on === true, 'B sees demo on')
      await ca.until((c) => c.type === 'demo' && c.on === true, 'A sees its own toggle echoed')
      assert.equal(await b.getDemoMode!(), true)
      b.setDemoMode!(false, 'user')
      await ca.until((c) => c.type === 'demo' && c.on === false, 'A sees demo off')
      assert.equal(await a.getDemoMode!(), false)
      ca.off()
      cb.off()
      a.close()
      b.close()
    })

    it('demo state survives a server restart (file database)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'office-contract-'))
      const dbPath = join(dir, 'office.db')
      const start = await loadStartServer()
      try {
        const first = await start({ port: 0, dbPath })
        const put = await fetch(`${first.url}/api/demo`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: true }) })
        assert.deepEqual(await put.json(), { on: true })
        const t = await createApiDataSource({ baseUrl: first.url }).createTask({ title: '재시작 후에도', projectId: 'p_web' })
        await first.close()
        const second = await start({ port: 0, dbPath })
        try {
          assert.deepEqual(await (await fetch(`${second.url}/api/demo`)).json(), { on: true }, 'demo restored on boot')
          const ws = (await (await fetch(`${second.url}/api/workspace`)).json()) as Workspace
          assert.ok(ws.tasks.some((x) => x.id === t.id), 'data restored on boot')
          await fetch(`${second.url}/api/demo`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: false }) })
        } finally {
          await second.close()
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('a manager patch of any member field (not only presence) protects the member from the bot', async () => {
      const a = await open()
      const target = a.ws.members[3]
      const actor = a.ws.members[0].id
      const botPatch = () =>
        fetch(`${shared.url}/api/members/${target.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-actor': actor }, body: JSON.stringify({ presence: 'break' }) })
      await a.source.updateMember(target.id, { name: '이름만 바꿈' })
      const blocked = await botPatch()
      assert.equal(blocked.status, 409)
      assert.equal(((await blocked.json()) as { error: { code: string } }).error.code, 'conflict')
      assert.equal((await a.source.load()).members.find((m) => m.id === target.id)!.presence, target.presence)
      a.source.close()
    })

    it('mutation responses carry X-Seq', async () => {
      await reseed(shared.url)
      const ws = (await (await fetch(`${shared.url}/api/workspace`)).json()) as Workspace
      const res = await fetch(`${shared.url}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '시퀀스', projectId: ws.projects[0].id }) })
      assert.equal(res.status, 201)
      assert.match(res.headers.get('x-seq') ?? '', /^\d+$/)
    })

    describe('request hygiene', () => {
      const rawGet = (path: string, headers: Record<string, string>) =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          const u = new URL(shared.url)
          const req = httpRequest({ host: u.hostname, port: u.port, path, method: 'GET', headers }, (res) => {
            let body = ''
            res.on('data', (d) => (body += d))
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
          })
          req.on('error', reject)
          req.end()
        })
      const forbidden = { error: { code: 'invalid', message: '허용되지 않은 요청이에요' } }

      it('rejects a foreign Origin', async () => {
        for (const origin of ['http://evil.example', 'https://localhost:5173', 'null']) {
          const res = await fetch(`${shared.url}/api/workspace`, { headers: { Origin: origin } })
          assert.equal(res.status, 403, origin)
          assert.deepEqual(await res.json(), forbidden)
        }
        const ok = await fetch(`${shared.url}/api/workspace`, { headers: { Origin: 'http://localhost:5173' } })
        assert.equal(ok.status, 200, 'a localhost dev origin is allowed')
        const ok2 = await fetch(`${shared.url}/api/workspace`, { headers: { Origin: 'http://127.0.0.1:5173' } })
        assert.equal(ok2.status, 200)
      })

      it('rejects writes that are not application/json', async () => {
        const text = await fetch(`${shared.url}/api/tasks`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ title: 'x', projectId: 'p_web' }) })
        assert.equal(text.status, 403)
        assert.deepEqual(await text.json(), forbidden)
        const form = await fetch(`${shared.url}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'title=x&projectId=p_web' })
        assert.equal(form.status, 403)
        const none = await fetch(`${shared.url}/api/reset`, { method: 'POST' })
        assert.equal(none.status, 403, 'a body-less write without content-type')
        const patch = await fetch(`${shared.url}/api/tasks/nope`, { method: 'PATCH', headers: { 'content-type': 'text/plain' }, body: '{}' })
        assert.equal(patch.status, 403)
        const put = await fetch(`${shared.url}/api/demo`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: '{"on":true}' })
        assert.equal(put.status, 403)
        assert.equal((await (await fetch(`${shared.url}/api/demo`)).json() as { on: boolean }).on, false, 'the forbidden PUT changed nothing')
        const ok = await fetch(`${shared.url}/api/reset`, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{}' })
        assert.equal(ok.status, 200)
      })

      it('rejects a foreign Host header (DNS rebinding)', async () => {
        const port = new URL(shared.url).port
        const evil = await rawGet('/api/workspace', { host: 'evil.example' })
        assert.equal(evil.status, 403)
        assert.deepEqual(JSON.parse(evil.body), forbidden)
        const wrongPort = await rawGet('/api/workspace', { host: 'localhost:9' })
        assert.equal(wrongPort.status, 403, 'right name, wrong port')
        const localhost = await rawGet('/api/workspace', { host: `localhost:${port}` })
        assert.equal(localhost.status, 200)
        const ip = await rawGet('/api/workspace', { host: `127.0.0.1:${port}` })
        assert.equal(ip.status, 200)
      })

      it('applies to the event stream too', async () => {
        const res = await fetch(`${shared.url}/api/events`, { headers: { Origin: 'http://evil.example' } })
        assert.equal(res.status, 403)
        await res.body?.cancel()
      })
    })
  })
}
