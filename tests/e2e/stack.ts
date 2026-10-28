// Throwaway extra servers for tests that must break the backend (OWNER: qa-engineer).
// Every process started here is a direct child we hold the handle (and PID) of; only those are stopped.
import { spawn, type ChildProcess } from 'node:child_process'

const root = process.cwd()

export interface Proc {
  child: ChildProcess
  pid: number
  /** Stop exactly this process (by the handle we got from spawn) and wait until it is gone. */
  stop(): Promise<void>
}

function launch(args: string[], env: Record<string, string>): Proc {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true })
  const proc: Proc = {
    child,
    pid: child.pid ?? -1,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve()
        child.once('exit', () => resolve())
        child.kill()
      }),
  }
  return proc
}

async function until(url: string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms
  for (;;) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      /* not listening yet */
    }
    if (Date.now() > end) throw new Error(`${url} did not come up`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

/** In-memory API (same script as the main e2e API) on `port`. */
export async function startApi(port: number): Promise<Proc> {
  const proc = launch(['--import', 'tsx', 'tests/e2e/serve-api.ts'], { PORT: String(port) })
  await until(`http://127.0.0.1:${port}/api/health`)
  return proc
}

/** Vite dev server on `port` proxying /api to `apiPort`. */
export async function startWeb(port: number, apiPort: number): Promise<Proc> {
  const proc = launch(['node_modules/vite/bin/vite.js', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { API_PORT: String(apiPort) })
  await until(`http://127.0.0.1:${port}/`)
  return proc
}
