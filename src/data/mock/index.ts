// OWNER: data-engineer. A DataSource backed by seed data + localStorage + demo mode.
// engine.ts = validated mutations, seed.ts = initial data, storage.ts = persistence,
// demo.ts = simulated teammates, text.ts = Korean message helpers.
import type { DataSource } from '../DataSource'
import { createDemo } from './demo'
import { createEngine } from './engine'
import { createLeader, defaultLocks, type LockManagerLike } from './leader'
import { defaultStorage, type StorageLike } from './storage'

export type { StorageLike } from './storage'
export { createMemoryStorage, createSharedMemoryStorage } from './storage'

export interface MockOptions {
  /** localStorage-like store. Default: window.localStorage when available, else in-memory. */
  storage?: StorageLike
  /** Simulated network latency [min, max] in ms. Default [50, 150]; use [0, 0] in tests. */
  latencyMs?: [number, number]
  random?: () => number
  now?: () => Date
  /**
   * Run the real timers (demo ticks, planned returns, lease heartbeat). Default true; tests set false
   * and drive `demoTick()` / `returnTick()` / `leaderTick()` themselves.
   */
  autoRun?: boolean
  /** Web Locks manager for demo leader election; null forces the storage heartbeat. Default: navigator.locks. */
  locks?: LockManagerLike | null
}

/** The data source plus test-only hooks. Not part of the DataSource interface. */
export interface MockHandle {
  source: DataSource
  /** Runs one demo action immediately; returns its name (or null when none was feasible). */
  demoTick(): string | null
  /** Writes pending changes to storage immediately. */
  flush(): void
  /** Fires what the (real-time) return timer would fire now: due members go back to work. */
  returnTick(): void
  /** Runs the leader-lease heartbeat / takeover check once (storage fallback). */
  leaderTick(): void
  /** Whether this instance currently runs demo mode (is the leader). */
  isLeader(): boolean
}

export function createMockDataSourceForTest(opts: MockOptions = {}): MockHandle {
  const storage = opts.storage ?? defaultStorage()
  const random = opts.random ?? Math.random
  const now = opts.now ?? (() => new Date())
  const [minLatency, maxLatency] = opts.latencyMs ?? [50, 150]

  const engine = createEngine({ storage, random, now })
  const autoRun = opts.autoRun ?? true
  const leader = createLeader({
    storage,
    now,
    locks: opts.locks === undefined ? defaultLocks() : opts.locks,
    autoRun,
    onChange: () => demo.onLeaderChange(),
  })
  const demo = createDemo(engine, { random, now, leader, autoRun })

  const wait = async (): Promise<void> => {
    const ms = maxLatency <= 0 ? 0 : minLatency + random() * (maxLatency - minLatency)
    if (ms <= 0) {
      await Promise.resolve()
      return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, ms))
  }

  const source: DataSource = {
    label: '로컬 데모 데이터',
    async load() {
      await wait()
      const ws = engine.snapshot()
      demo.adopt() // members persisted in a meeting / on a break come back soon, even with demo off
      return ws
    },
    async createTask(input) {
      await wait()
      return engine.createTask(input)
    },
    async updateTask(id, patch) {
      await wait()
      return engine.updateTask(id, patch)
    },
    async deleteTask(id) {
      await wait()
      engine.deleteTask(id)
    },
    async createMember(input) {
      await wait()
      return engine.createMember(input)
    },
    async updateMember(id, patch) {
      await wait()
      return engine.updateMember(id, patch)
    },
    async deleteMember(id, reassign) {
      await wait()
      engine.deleteMember(id, reassign)
    },
    subscribe: (listener) => engine.subscribe(listener),
    setDemoMode(on) {
      if (on) demo.start()
      else demo.stop()
    },
    async reset() {
      await wait()
      return engine.reset()
    },
  }

  return { source, demoTick: () => demo.tick(), flush: () => engine.flush(), returnTick: () => demo.returnTick(), leaderTick: () => leader.tick(), isLeader: () => leader.isLeader() }
}

export function createMockDataSource(opts?: MockOptions): DataSource {
  return createMockDataSourceForTest(opts).source
}
