// CLI entry: `npm run server`. Starts the API on :8787 with the persistent database.
import { startServer } from './app.ts'

const port = Number(process.env.PORT ?? 8787)
const server = await startServer({ port, demo: process.env.DEMO === '1' ? true : undefined })
console.log(`Team office API listening on ${server.url}`)

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    void server.close().finally(() => process.exit(0))
  })
}
