// Starts a throwaway API server (in-memory SQLite) for the e2e suite. Run: PORT=8790 node --import tsx tests/e2e/serve-api.ts
// Own file so the suite never touches the dev server on :8787 or its server/data/office.db.
import { startServer } from '../../server/src/app.ts'

const port = Number(process.env.PORT)
if (!Number.isInteger(port) || port <= 0) throw new Error('serve-api: set PORT')

const server = await startServer({ port, dbPath: ':memory:' })
console.log(`e2e api listening on ${server.url}`)

const stop = () => {
  void server.close().finally(() => process.exit(0))
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
