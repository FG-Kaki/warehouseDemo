// Wires storage, change stream, HTTP routes and the demo bot together.
import { mkdirSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { TOUCH_WINDOW_MS } from '../../src/data/rules/constants.ts'
import { createBot } from './bot/index.ts'
import { openDb } from './db.ts'
import { createHub } from './events.ts'
import { createRepo } from './repo.ts'
import { createApp } from './routes.ts'

export interface ServerOptions {
  /** 0 = random free port; CLI default 8787. */
  port?: number
  /** ':memory:' allowed; CLI default server/data/office.db. */
  dbPath?: string
  /** Start the bot on boot; default false. */
  demo?: boolean
  /** Bot tick range in ms; default [8000, 15000]. */
  botTickMs?: [number, number]
  /** Manager-touch protection window in ms; default 120000. */
  touchWindowMs?: number
}

const DEFAULT_DB = fileURLToPath(new URL('../data/office.db', import.meta.url))
const HOST = '127.0.0.1'

export async function startServer(opts: ServerOptions = {}): Promise<{ url: string; close(): Promise<void> }> {
  const dbPath = opts.dbPath ?? DEFAULT_DB
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
  const db = openDb(dbPath)

  let closing = false
  const hub = createHub({
    startSeq: Number(db.meta('seq') ?? '0'),
    snapshot: () => repo.workspace(),
  })
  const repo = createRepo(db, hub.publish, { touchWindowMs: opts.touchWindowMs ?? TOUCH_WINDOW_MS })
  repo.seedIfEmpty()

  let bot: ReturnType<typeof createBot> | null = null
  let port = 0
  const app = createApp({
    repo,
    hub,
    isClosing: () => closing,
    port: () => port,
    applyDemo(on) {
      if (on) bot?.start()
      else bot?.stop()
    },
  })

  const server = await new Promise<Server>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, port: opts.port ?? 0, hostname: HOST }) as Server
    s.once('listening', () => resolve(s))
    s.once('error', reject)
  }).catch((e) => {
    hub.close()
    db.close()
    throw e
  })

  port = (server.address() as AddressInfo).port
  const url = `http://${HOST}:${port}`
  bot = createBot({ baseUrl: url, touchWindowMs: opts.touchWindowMs, tickMs: opts.botTickMs ?? [8000, 15_000], log: (m) => console.warn(m) })
  // An explicit option wins (and is stored); otherwise the flag persisted by PUT /api/demo is restored.
  if (opts.demo !== undefined) repo.storeDemo(opts.demo)
  if (repo.demoOn()) bot.start()

  let closed: Promise<void> | null = null
  return {
    url,
    close() {
      closed ??= (async () => {
        closing = true
        bot?.dispose()
        hub.close()
        await new Promise<void>((resolve) => {
          // Let the ended SSE streams flush their last bytes, then cut whatever is still open.
          const force = setTimeout(() => server.closeAllConnections(), 250)
          server.close(() => {
            clearTimeout(force)
            resolve()
          })
          server.closeIdleConnections()
        })
        db.close()
      })()
      return closed
    },
  }
}
