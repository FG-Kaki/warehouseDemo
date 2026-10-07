// Contract suite against the mock data source (in-memory storage, no latency, no timers),
// plus mock-only checks that mirror server rules.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createMemoryStorage, createMockDataSource, createMockDataSourceForTest, createSharedMemoryStorage } from '../../src/data/mock'
import { STORAGE_KEY } from '../../src/data/mock/storage'
import type { Change } from '../../src/data/types'
import { defineContractSuite, rejectsWith } from './scenarios'

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

  it('demo never moves a meeting\'s attendees and starts no informal meeting of its own', async () => {
    let clock = Date.now()
    let seed = 7
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 4294967296
    }
    const run = async (withMeeting: boolean) => {
      const h = createMockDataSourceForTest({ storage: createMemoryStorage(), latencyMs: [0, 0], autoRun: false, locks: null, now: () => new Date(clock), random })
      const changes: Change[] = []
      h.source.subscribe((c) => changes.push(c))
      h.source.setDemoMode!(true)
      const ws = await h.source.load()
      // m_3 starts in the seed's informal meeting (with a planned return); m_1 / m_2 are at their desks
      const attendeeIds = [ws.members[0].id, ws.members[1].id, ws.members[2].id]
      const meeting = withMeeting ? await h.source.startMeeting({ title: '긴 회의', attendeeIds }) : null
      changes.length = 0
      const presenceOf = async () => (await h.source.load()).members.filter((m) => attendeeIds.includes(m.id)).map((m) => m.presence)
      let moved = false
      for (let i = 0; i < 60; i++) {
        clock += 10_000 // 10 simulated minutes: far past the manager-touch window and every planned return
        h.returnTick()
        h.demoTick()
        if ((await presenceOf()).some((p) => p !== 'meeting')) moved = true
      }
      const informal = changes.filter((c) => c.type === 'activity' && c.activity.message.endsWith('회의가 시작됐어요')).length
      return { h, meeting, moved, informal, attendeeIds, presenceOf }
    }
    const control = await run(false)
    assert.ok(control.moved, 'control: without a manager meeting the demo sends people back and forth')
    const r = await run(true)
    assert.equal(r.moved, false, 'attendees stay in the meeting for as long as it runs')
    assert.equal(r.informal, 0, 'no informal meeting starts during a meeting')
    // ending it sends them back, and nothing is stuck in the meeting afterwards
    await r.h.source.endMeeting(r.meeting!.id, { notes: '', outcomes: [] })
    assert.deepEqual(await r.presenceOf(), ['working', 'working', 'working'])
  })

  it('data saved before meetings existed (no onAgenda, no meetings) loads cleanly', async () => {
    const storage = createMemoryStorage()
    const first = createMockDataSourceForTest({ storage, latencyMs: [0, 0], autoRun: false, locks: null })
    await first.source.load()
    first.flush()
    const legacy = JSON.parse(storage.getItem(STORAGE_KEY)!)
    delete legacy.workspace.meetings
    for (const t of legacy.workspace.tasks) delete t.onAgenda
    storage.setItem(STORAGE_KEY, JSON.stringify(legacy))
    const second = createMockDataSourceForTest({ storage, latencyMs: [0, 0], autoRun: false, locks: null })
    const ws = await second.source.load()
    assert.ok(ws.tasks.every((t) => t.onAgenda === false), 'missing onAgenda repairs to false')
    assert.deepEqual(ws.meetings, [])
    assert.ok(!ws.activity.some((a) => a.kind === 'system'), 'old data is not reported as damaged')
  })

  it('meetings and the agenda survive a reload', async () => {
    const storage = createMemoryStorage()
    const a = createMockDataSourceForTest({ storage, latencyMs: [0, 0], autoRun: false, locks: null })
    const ws = await a.source.load()
    const [m1, m2] = ws.members
    const done = await a.source.startMeeting({ title: '기록 회의', attendeeIds: [m1.id] })
    await a.source.endMeeting(done.id, { notes: '메모', outcomes: [{ taskId: ws.tasks.find((t) => t.number === 35)!.id, action: 'keep' }] })
    const going = await a.source.startMeeting({ title: '진행 회의', attendeeIds: [m2.id] })
    a.flush()
    const b = createMockDataSourceForTest({ storage, latencyMs: [0, 0], autoRun: false, locks: null })
    const again = await b.source.load()
    assert.deepEqual(again.meetings.map((m) => [m.id, m.status, m.notes]), [[done.id, 'ended', '메모'], [going.id, 'ongoing', '']])
    assert.deepEqual(again.meetings[0].outcomes, [{ taskId: ws.tasks.find((t) => t.number === 35)!.id, action: 'keep' }])
    assert.equal(again.tasks.filter((t) => t.onAgenda).length, 2)
    await rejectsWith(b.source.startMeeting({ title: '또', attendeeIds: [m1.id] }), 'conflict', '이미 회의가 진행 중이에요', 'ongoing meeting is restored')
  })

  it('another tab sees meetings and agenda changes', async () => {
    const hub = createSharedMemoryStorage()
    const a = createMockDataSourceForTest({ storage: hub.view(), latencyMs: [0, 0], autoRun: false, locks: null })
    const b = createMockDataSourceForTest({ storage: hub.view(), latencyMs: [0, 0], autoRun: false, locks: null })
    const ws = await a.source.load()
    await b.source.load()
    const seen: Change[] = []
    b.source.subscribe((c) => seen.push(c))
    const t = ws.tasks.find((x) => x.number === 31)!
    await a.source.updateTask(t.id, { onAgenda: true })
    a.flush()
    assert.ok(seen.some((c) => c.type === 'task_upsert' && c.task.id === t.id && c.task.onAgenda === true), 'onAgenda reaches the other tab')
    const meeting = await a.source.startMeeting({ title: '탭 회의', attendeeIds: [ws.members[0].id] })
    a.flush()
    assert.ok(seen.some((c) => c.type === 'meeting_upsert' && c.meeting.id === meeting.id && c.meeting.status === 'ongoing'), 'the ongoing meeting reaches the other tab')
    await rejectsWith(b.source.startMeeting({ title: '다른 탭 회의', attendeeIds: [ws.members[1].id] }), 'conflict', '이미 회의가 진행 중이에요', 'the other tab knows it is ongoing')
    await a.source.endMeeting(meeting.id, { notes: '끝', outcomes: [] })
    a.flush()
    assert.ok(seen.some((c) => c.type === 'meeting_upsert' && c.meeting.id === meeting.id && c.meeting.status === 'ended' && c.meeting.notes === '끝'), 'the ended meeting reaches the other tab')
  })

  it('demo leaves open agenda tasks alone (never takes, starts, moves or completes them)', async () => {
    const run = async (agenda: boolean) => {
      let clock = Date.now()
      let seed = 99
      const random = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0
        return seed / 4294967296
      }
      const h = createMockDataSourceForTest({ storage: createMemoryStorage(), latencyMs: [0, 0], autoRun: false, locks: null, now: () => new Date(clock), random })
      const ws = await h.source.load()
      const watched = ws.tasks.filter((t) => t.onAgenda)
      assert.deepEqual(watched.map((t) => t.number).sort((a, b) => a - b), [20, 35])
      if (!agenda) for (const t of watched) await h.source.updateTask(t.id, { onAgenda: false })
      const before = new Map((await h.source.load()).tasks.filter((t) => watched.some((w) => w.id === t.id)).map((t) => [t.id, JSON.stringify(t)]))
      h.source.setDemoMode!(true)
      clock += 130_000 // manager touches have expired
      for (let i = 0; i < 300; i++) {
        clock += 10_000
        h.returnTick()
        h.demoTick()
        if (agenda) {
          const now = (await h.source.load()).tasks.filter((t) => watched.some((w) => w.id === t.id))
          for (const t of now) assert.equal(JSON.stringify(t), before.get(t.id), `agenda task #${t.number} untouched (tick ${i})`)
        }
      }
      const after = (await h.source.load()).tasks.filter((t) => watched.some((w) => w.id === t.id))
      return after.some((t) => JSON.stringify(t) !== before.get(t.id))
    }
    assert.equal(await run(true), false, 'agenda tasks never change')
    assert.equal(await run(false), true, 'control: without the agenda the demo does work on those tasks')
  })

  it('a meeting another tab ended is not resurrected by this tab\'s unsaved edit (end vs delete race)', async () => {
    const hub = createSharedMemoryStorage()
    const a = createMockDataSourceForTest({ storage: hub.view(), latencyMs: [0, 0], autoRun: false, locks: null })
    const b = createMockDataSourceForTest({ storage: hub.view(), latencyMs: [0, 0], autoRun: false, locks: null })
    const ws = await a.source.load()
    await b.source.load()
    const meeting = await a.source.startMeeting({ title: '경합 회의', attendeeIds: [ws.members[0].id] })
    a.flush()
    const seenByB: Change[] = []
    b.source.subscribe((c) => seenByB.push(c))
    // tab B deletes an agenda task (an unsaved change of the ongoing meeting) ...
    const victim = meeting.agendaTaskIds[0]
    await b.source.deleteTask(victim)
    // ... while tab A ends the meeting and saves first
    await a.source.endMeeting(meeting.id, { notes: '끝', outcomes: [] })
    a.flush()
    b.flush()
    a.flush()
    for (const [name, h] of [['a', a], ['b', b]] as const) {
      const w = await h.source.load()
      assert.equal(w.meetings.length, 1, `${name}: one meeting`)
      assert.equal(w.meetings[0].status, 'ended', `${name}: still ended`)
      assert.equal(w.meetings[0].notes, '끝', `${name}: minutes kept`)
      assert.ok(!w.tasks.some((t) => t.id === victim), `${name}: the deletion stuck`)
      assert.equal(w.members[0].presence, 'working', `${name}: attendee is back at work`)
    }
    const stored = JSON.parse(hub.view().getItem(STORAGE_KEY)!).workspace
    assert.deepEqual(stored.meetings.map((m: { status: string }) => m.status), ['ended'])
  })

  it('when two tabs start a meeting at once, the later one is closed and says so', async () => {
    const hub = createSharedMemoryStorage()
    let clockB = Date.now() + 5000
    const a = createMockDataSourceForTest({ storage: hub.view(), latencyMs: [0, 0], autoRun: false, locks: null })
    const b = createMockDataSourceForTest({ storage: hub.view(), latencyMs: [0, 0], autoRun: false, locks: null, now: () => new Date(clockB) })
    const ws = await a.source.load()
    await b.source.load()
    const seenByB: Change[] = []
    b.source.subscribe((c) => seenByB.push(c))
    await a.source.startMeeting({ title: '먼저 시작', attendeeIds: [ws.members[0].id] })
    await b.source.startMeeting({ title: '나중 시작', attendeeIds: [ws.members[1].id] })
    a.flush()
    b.flush()
    a.flush()
    const w = await b.source.load()
    assert.deepEqual(w.meetings.map((m) => [m.title, m.status]), [['먼저 시작', 'ongoing'], ['나중 시작', 'ended']])
    assert.ok(w.activity.some((x) => x.kind === 'system' && x.message === '다른 탭에서 시작한 회의가 있어 이 회의를 닫았어요'), 'the closing is announced')
    assert.equal(w.members[1].presence, 'working', 'the closed meeting\'s attendee is released')
    assert.equal(w.members[0].presence, 'meeting')
  })
})
