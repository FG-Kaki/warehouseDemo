// Contract suite against the mock data source (in-memory storage, no latency, no timers),
// plus mock-only checks that mirror server rules.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createMemoryStorage, createMockDataSource, createMockDataSourceForTest } from '../../src/data/mock'
import { defineContractSuite } from './scenarios'

defineContractSuite('mock', async () => ({
  source: createMockDataSource({ storage: createMemoryStorage(), latencyMs: [0, 0], autoRun: false, locks: null }),
  dispose: () => {},
}))

describe('mock only', () => {
  // The server treats ANY manager patch of a member (not just presence) as a touch that keeps the demo
  // bot away for the touch window. The mock's demo must behave the same.
  it('a manager member patch of any field protects that member from demo presence changes', async () => {
    const run = async (touch: boolean) => {
      let clock = Date.now()
      let seed = 123
      const random = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0
        return seed / 4294967296
      }
      const h = createMockDataSourceForTest({ storage: createMemoryStorage(), latencyMs: [0, 0], autoRun: false, locks: null, now: () => new Date(clock), random })
      h.source.setDemoMode!(true)
      const ws = await h.source.load()
      clock += 60_000
      h.returnTick() // let the seed's meeting / break members come back first
      if (touch) for (const m of ws.members) await h.source.updateMember(m.id, { capacity: m.capacity + 1 }) // not presence
      const before = (await h.source.load()).members.map((m) => m.presence)
      let changed = false
      for (let i = 0; i < 9; i++) {
        clock += 10_000 // 90 s: inside the 2 minute window
        h.demoTick()
        const now = (await h.source.load()).members.map((m) => m.presence)
        if (JSON.stringify(now) !== JSON.stringify(before)) changed = true
      }
      return changed
    }
    // control: without touches the demo does move people within the same time span (so the test has teeth)
    let controlMoved = false
    for (let attempt = 0; attempt < 1 && !controlMoved; attempt++) controlMoved = await run(false)
    assert.ok(controlMoved, 'control run: demo changes presence when nothing was touched')
    assert.equal(await run(true), false, 'touched members are left alone')
  })
})
