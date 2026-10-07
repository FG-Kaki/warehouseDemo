// HTTP surface (docs/API.md). Thin: parse the request, call the repo, shape the response.
import { Hono, type Context } from 'hono'
import { DataError, type DataErrorCode } from '../../src/data/DataSource.ts'
import type { Reassign } from '../../src/data/types.ts'
import type { Hub } from './events.ts'
import { MANAGER, type Ctx, type Repo } from './repo.ts'
import { isObj } from '../../src/data/rules/validate.ts'

export interface RouteDeps {
  repo: Repo
  hub: Hub
  /** Starts / stops the bot to match the (already persisted) demo flag. */
  applyDemo(on: boolean): void
  isClosing(): boolean
  /** The port actually listening (known after listen when port 0 was asked for). */
  port(): number
}

const STATUS: Record<DataErrorCode, 400 | 404 | 409 | 503> = { invalid: 400, not_found: 404, conflict: 409, unavailable: 503 }
const JSON_TYPE = 'application/json; charset=utf-8'

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': JSON_TYPE, ...headers } })
}

function errorResponse(code: DataErrorCode, message: string, status: number = STATUS[code]): Response {
  return json({ error: { code, message } }, status)
}

/** Body as an object, or null when it is missing / not JSON / not an object (the repo then reports the usual Korean message). */
async function readBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return null
  }
}

const WRITES = new Set(['POST', 'PUT', 'PATCH'])
const ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i

export function createApp({ repo, hub, applyDemo, isClosing, port }: RouteDeps) {
  const app = new Hono()

  app.use('*', async (_c, next) => {
    if (isClosing()) return errorResponse('unavailable', '서버를 종료하는 중이에요')
    await next()
  })

  // Request hygiene: any web page can fire requests at localhost, so only accept what our own client sends.
  app.use('*', async (c, next) => {
    const host = c.req.header('Host')?.toLowerCase()
    const origin = c.req.header('Origin')
    const type = c.req.header('Content-Type')?.split(';')[0].trim().toLowerCase()
    const hostOk = host === `localhost:${port()}` || host === `127.0.0.1:${port()}`
    const originOk = origin === undefined || ORIGIN.test(origin)
    const typeOk = !WRITES.has(c.req.method) || type === 'application/json'
    if (!hostOk || !originOk || !typeOk) return errorResponse('invalid', '허용되지 않은 요청이에요', 403)
    await next()
  })

  /** Who is asking: `X-Actor` = a member (the demo bot), absent = the manager. Unknown actor -> 400. */
  function ctxOf(c: Context): Ctx {
    const id = c.req.header('X-Actor')
    if (id === undefined) return MANAGER
    const actor = repo.findMember(id)
    if (!actor) throw new DataError('알 수 없는 팀원이에요', 'invalid')
    // X-Quiet: 1 lets the bot skip the activity row of routine moves (keeps the feed to ~4 rows/min).
    return { actor, quiet: c.req.header('X-Quiet') === '1' }
  }

  app.get('/api/health', () => json({ ok: true, version: 1 }))

  app.get('/api/workspace', () => json(repo.workspace(), 200, { 'X-Seq': String(hub.seq) }))

  const seqHeader = (seq: number) => ({ 'X-Seq': String(seq) })
  const noContent = (seq: number) => new Response(null, { status: 204, headers: seqHeader(seq) })

  app.post('/api/tasks', async (c) => {
    const { value, seq } = repo.createTask(await readBody(c), ctxOf(c))
    return json(value, 201, seqHeader(seq))
  })
  app.patch('/api/tasks/:id', async (c) => {
    const { value, seq } = repo.updateTask(c.req.param('id'), await readBody(c), ctxOf(c))
    return json(value, 200, seqHeader(seq))
  })
  app.delete('/api/tasks/:id', (c) => noContent(repo.deleteTask(c.req.param('id'), ctxOf(c)).seq))

  app.post('/api/members', async (c) => {
    const { value, seq } = repo.createMember(await readBody(c), ctxOf(c))
    return json(value, 201, seqHeader(seq))
  })
  app.patch('/api/members/:id', async (c) => {
    const { value, seq } = repo.updateMember(c.req.param('id'), await readBody(c), ctxOf(c))
    return json(value, 200, seqHeader(seq))
  })
  app.delete('/api/members/:id', (c) => {
    const to = c.req.query('reassignTo')
    const mode = c.req.query('reassign')
    let reassign: Reassign | null = null
    if (to !== undefined) reassign = { mode: 'member', memberId: to }
    else if (mode === 'backlog') reassign = { mode: 'backlog' }
    return noContent(repo.deleteMember(c.req.param('id'), reassign, ctxOf(c)).seq)
  })

  app.post('/api/meetings', async (c) => {
    const { value, seq } = repo.startMeeting(await readBody(c), ctxOf(c))
    return json(value, 201, seqHeader(seq))
  })
  app.post('/api/meetings/:id/end', async (c) => {
    const { value, seq } = repo.endMeeting(c.req.param('id'), await readBody(c), ctxOf(c))
    return json(value, 200, seqHeader(seq))
  })

  app.get('/api/demo',() => json({ on: repo.demoOn() }))
  app.put('/api/demo', async (c) => {
    const body = await readBody(c)
    if (!isObj(body) || typeof body.on !== 'boolean') throw new DataError('요청 내용이 올바르지 않아요')
    const { value, seq } = repo.setDemo(body.on)
    applyDemo(value)
    return json({ on: value }, 200, seqHeader(seq))
  })

  app.post('/api/reset', () => {
    const { value, seq } = repo.reset()
    return json(value, 200, seqHeader(seq))
  })

  app.get('/api/events', (c) => hub.connect(c.req.header('Last-Event-ID') ?? null))

  app.notFound(() => errorResponse('not_found', '찾을 수 없는 주소예요'))
  app.onError((e) => {
    if (e instanceof DataError) return errorResponse(e.code, e.message)
    const busy = e instanceof Error && /SQLITE_BUSY|database is locked/i.test(e.message)
    if (!busy) console.error('server error:', e)
    return errorResponse('unavailable', busy ? '잠시 후에 다시 시도해 주세요' : '서버에 문제가 생겼어요')
  })

  return app
}
