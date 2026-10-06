// Smoke test for the mock data source. Run: npx --yes tsx scripts/data-smoke.ts
import { DataError } from '../src/data/DataSource'
import { AVATAR_VARIANTS } from '../src/data/meta'
import { backlogTasks, computeKpis, isOverdue, workload } from '../src/data/selectors'
import type { Change, Task, Workspace } from '../src/data/types'
import { MAX_MEMBERS, OFFICE } from '../src/office/layout'
import { createMockDataSourceForTest } from '../src/data/mock'
import { CORRUPT_KEY, createMemoryStorage, createSharedMemoryStorage, META_KEY, STORAGE_KEY } from '../src/data/mock/storage'
import type { LockManagerLike } from '../src/data/mock/leader'

let checks = 0
function assert(cond: unknown, msg: string): asserts cond {
  checks++
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}

async function rejects(p: Promise<unknown>, msgPart: string, label: string, code?: DataError['code']) {
  try {
    await p
  } catch (e) {
    assert(e instanceof DataError, `${label}: expected DataError, got ${String(e)}`)
    if (code) assert((e as DataError).code === code, `${label}: code ${(e as DataError).code} should be ${code}`)
    assert((e as Error).message.includes(msgPart), `${label}: message "${(e as Error).message}" should include "${msgPart}"`)
    return
  }
  throw new Error(`ASSERT FAILED: ${label}: expected rejection`)
}

function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function checkInvariants(ws: Workspace, label: string) {
  const memberIds = new Set(ws.members.map((m) => m.id))
  assert(memberIds.size === ws.members.length, `${label}: unique member ids`)
  assert(ws.members.length <= MAX_MEMBERS, `${label}: member cap`)
  const desks = ws.members.map((m) => m.deskId)
  assert(new Set(desks).size === desks.length, `${label}: unique desks`)
  assert(desks.every((d) => OFFICE.desks.some((x) => x.id === d)), `${label}: desks exist`)
  const projectIds = new Set(ws.projects.map((p) => p.id))
  const numbers = ws.tasks.map((t) => t.number)
  assert(new Set(numbers).size === numbers.length, `${label}: unique task numbers`)
  assert(new Set(ws.tasks.map((t) => t.id)).size === ws.tasks.length, `${label}: unique task ids`)
  for (const t of ws.tasks) {
    assert(t.assigneeId === null || memberIds.has(t.assigneeId), `${label}: no orphan assignee (${t.id})`)
    assert(projectIds.has(t.projectId), `${label}: project exists`)
    assert((t.status === 'done') === (t.completedAt !== null), `${label}: done <=> completedAt (${t.id} ${t.status})`)
    assert(Number.isFinite(t.order), `${label}: order finite`)
  }
  assert(ws.activity.length <= 100, `${label}: activity capped`)
  assert(new Set(ws.activity.map((a) => a.id)).size === ws.activity.length, `${label}: unique activity ids`)
}

function open(
  opts: { storage?: ReturnType<typeof createMemoryStorage>; seed?: number; now?: () => Date; demo?: boolean; locks?: LockManagerLike | null } = {},
) {
  const storage = opts.storage ?? createMemoryStorage()
  // autoRun off: no real timers; the test drives demoTick() / returnTick() / leaderTick() on a fake clock.
  const handle = createMockDataSourceForTest({ storage, latencyMs: [0, 0], random: mulberry32(opts.seed ?? 1), now: opts.now, autoRun: false, locks: opts.locks ?? null })
  const changes: Change[] = []
  handle.source.subscribe((c) => changes.push(c))
  // The demo wish (what the store sets); only the leader tab acts on it.
  if (opts.demo !== false) handle.source.setDemoMode!(true)
  return { storage, handle, source: handle.source, changes }
}

/** Minimal Web Locks stand-in: exclusive lock with a FIFO queue and abortable requests. */
function createFakeLocks(): LockManagerLike {
  let held = false
  const queue: (() => void)[] = []
  const next = () => {
    held = false
    queue.shift()?.()
  }
  return {
    request(_name, options, callback) {
      return new Promise((resolve, reject) => {
        const run = () => {
          held = true
          callback().then(
            (v) => {
              resolve(v)
              next()
            },
            (e) => {
              reject(e)
              next()
            },
          )
        }
        options.signal?.addEventListener('abort', () => {
          const i = queue.indexOf(run)
          if (i >= 0) queue.splice(i, 1)
          reject(new Error('aborted'))
        })
        if (held) queue.push(run)
        else run()
      })
    },
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // ---- seed ------------------------------------------------------------------
  {
    const { source } = open()
    assert(source.label === '로컬 데모 데이터', 'label')
    const ws = await source.load()
    checkInvariants(ws, 'seed')
    assert(ws.projects.length === 3, '3 projects')
    assert(ws.members.length === 7, '7 members')
    assert(ws.tasks.length === 36, '36 tasks')
    assert(ws.tasks.every((t, i) => t.number === i + 1), 'numbers 1..36')
    const rec = Object.fromEntries(ws.tasks.map((t) => [t.id, t]))
    const loads = ws.members.map((m) => ({ name: m.name, w: workload(m, rec) }))
    const max = Math.max(...loads.map((l) => l.w))
    const min = Math.min(...loads.map((l) => l.w))
    assert(Math.abs(max - 1.4) < 0.05, `overloaded member ~1.4 (got ${max})`)
    assert(Math.abs(min - 0.4) < 0.05, `light member ~0.4 (got ${min})`)
    const by = (s: string) => ws.tasks.filter((t) => t.status === s).length
    assert(by('todo') === 14 && by('in_progress') === 8 && by('review') === 4 && by('done') === 10, 'status mix')
    assert(backlogTasks(rec).length === 6, '6 backlog tasks')
    const overdue = ws.tasks.filter((t) => isOverdue(t)).length
    assert(overdue === 3, `3 overdue (got ${overdue})`)
    for (const m of ws.members) assert(ws.tasks.filter((t) => t.assigneeId === m.id && t.status === 'in_progress').length <= 2, 'max 2 in progress each')
    assert(ws.members.every((m) => m.avatarVariant >= 0 && m.avatarVariant < AVATAR_VARIANTS), 'avatar variants in range')
    assert(ws.members.filter((m) => m.presence === 'meeting').length === 1 && ws.members.filter((m) => m.presence === 'break').length === 1, 'presence mix')
    assert(ws.activity.length >= 18 && ws.activity.length <= 25, `~20 activities (got ${ws.activity.length})`)
    const k = computeKpis(rec, Object.fromEntries(ws.members.map((m) => [m.id, m])))
    assert(k.unassigned === 6 && k.overdue === 3, 'kpis')
    // returns are copies
    ws.tasks[0].title = 'MUTATED'
    assert((await source.load()).tasks[0].title !== 'MUTATED', 'load returns deep copies')
    console.log(`seed ok: loads ${loads.map((l) => `${l.name} ${l.w.toFixed(2)}`).join(', ')}`)
    console.log(`  sample activity: ${ws.activity.slice(-3).map((a) => a.message).join(' | ')}`)
  }

  // ---- task CRUD + changes + validation ---------------------------------------
  {
    const { source, changes } = open()
    const ws = await source.load()
    const proj = ws.projects[0]
    const member = ws.members[0]

    changes.length = 0
    const t = await source.createTask({ title: '  새 작업  ', projectId: proj.id })
    assert(t.title === '새 작업' && t.status === 'todo' && t.priority === 'medium' && t.estimate === 3, 'create defaults')
    assert(t.description === '' && t.dueDate === null && t.assigneeId === null && t.completedAt === null, 'create defaults 2')
    assert(t.number === 37, 'next number 37')
    assert(changes.length === 2 && changes[0].type === 'task_upsert' && changes[1].type === 'activity', 'create emits upsert + activity')
    const act = changes[1].type === 'activity' ? changes[1].activity : null
    assert(act !== null && act.message.startsWith('새 작업 WEB-37') && act.actorId === null && act.taskId === t.id, `create message: ${act?.message}`)
    const backlogTop = Math.max(...ws.tasks.filter((x) => x.assigneeId === null).map((x) => x.order))
    assert(t.order > backlogTop, 'order on top of backlog')

    changes.length = 0
    const assigned = await source.updateTask(t.id, { assigneeId: member.id })
    assert(assigned.assigneeId === member.id, 'assigned')
    const topOfStack = Math.max(...ws.tasks.filter((x) => x.assigneeId === member.id).map((x) => x.order))
    assert(assigned.order > topOfStack, 'assign puts on top of stack')
    const aMsg = changes.find((c) => c.type === 'activity')
    assert(aMsg?.type === 'activity' && aMsg.activity.kind === 'task_assigned' && aMsg.activity.message.includes(`${member.name} 님에게 배정했어요`), `assign message: ${JSON.stringify(aMsg)}`)

    const before = assigned.updatedAt
    await sleep(5)
    const done = await source.updateTask(t.id, { status: 'done' })
    assert(done.completedAt !== null && done.updatedAt >= before, 'done sets completedAt')
    const reopened = await source.updateTask(t.id, { status: 'in_progress' })
    assert(reopened.completedAt === null, 'leaving done clears completedAt')

    changes.length = 0
    const noop = await source.updateTask(t.id, { status: 'in_progress' })
    assert(noop.id === t.id && changes.length === 0, 'no-op update emits nothing')

    changes.length = 0
    await source.deleteTask(t.id)
    assert(changes.map((c) => c.type).join() === 'task_delete,activity', 'delete emits delete + activity')
    assert(!(await source.load()).tasks.some((x) => x.id === t.id), 'task deleted')

    // validation
    await rejects(source.createTask({ title: '   ', projectId: proj.id }), '제목을 입력해 주세요', 'empty title', 'invalid')
    await rejects(source.createTask({ title: 'x'.repeat(121), projectId: proj.id }), '제목', 'long title')
    await rejects(source.createTask({ title: 'ok', projectId: 'nope' }), '프로젝트', 'bad project', 'invalid')
    await rejects(source.createTask({ title: 'ok', projectId: proj.id, assigneeId: 'nope' }), '팀원', 'bad assignee')
    await rejects(source.updateTask('nope', { title: 'x' }), '작업을 찾을 수 없어요', 'update unknown', 'not_found')
    await rejects(source.deleteTask('nope'), '작업을 찾을 수 없어요', 'delete unknown', 'not_found')
    await rejects(source.updateTask(ws.tasks[0].id, { title: '' }), '제목', 'update empty title')
    await rejects(source.updateTask(ws.tasks[0].id, { assigneeId: 'nope' }), '팀원', 'update bad assignee')
    await rejects(source.updateTask(ws.tasks[0].id, { projectId: 'nope' }), '프로젝트', 'update bad project')
    const count = (await source.load()).tasks.length
    assert(count === ws.tasks.length, 'failed calls changed nothing')
    // numbers never reused
    const t2 = await source.createTask({ title: '다음 작업', projectId: proj.id, assigneeId: member.id, status: 'in_progress', estimate: 5, priority: 'urgent', dueDate: '2030-01-31' })
    assert(t2.number === 38 && t2.dueDate === '2030-01-31', 'numbers keep increasing')
    await rejects(source.updateTask(t2.id, { dueDate: '2030-02-31' }), '마감일', 'invalid date')
    console.log('task CRUD ok')
  }

  // ---- members ---------------------------------------------------------------
  {
    const { source, changes } = open()
    const ws = await source.load()
    const first = ws.members[0]

    changes.length = 0
    const m = await source.createMember({ name: ' 신입  ', role: '백엔드', color: '#3a6df0', capacity: 8 })
    assert(m.name === '신입' && m.presence === 'working' && m.deskId === 'A5', `new member gets first free desk (got ${m.deskId})`)
    assert(m.avatarVariant >= 0 && m.avatarVariant < AVATAR_VARIANTS, 'random avatar variant in range')
    assert(changes[0].type === 'member_upsert' && changes[1].type === 'activity' && changes[1].activity.message === '신입 님이 합류했어요', 'member created changes')

    await rejects(source.createMember({ name: '', role: 'x', color: '#3a6df0', capacity: 8 }), '이름', 'empty name')
    await rejects(source.createMember({ name: 'x'.repeat(31), role: 'x', color: '#3a6df0', capacity: 8 }), '이름', 'long name')
    await rejects(source.createMember({ name: 'a', role: 'x', color: '#3a6df0', capacity: 0 }), '여유량', 'capacity 0')
    await rejects(source.createMember({ name: 'a', role: 'x', color: '#3a6df0', capacity: 41 }), '여유량', 'capacity 41')
    await rejects(source.createMember({ name: 'a', role: 'x', color: '#3a6df0', capacity: 8, deskId: first.deskId }), '이미 사용 중인 자리예요', 'desk taken', 'conflict')
    await rejects(source.createMember({ name: 'a', role: 'x', color: '#3a6df0', capacity: 8, deskId: 'Z9' }), '자리', 'desk unknown')
    const m2 = await source.createMember({ name: '둘째', role: '디자인', color: '#e05fa8', capacity: 8, deskId: 'B5' })
    assert(m2.deskId === 'B5', 'explicit free desk')
    const m3 = await source.createMember({ name: '셋째', role: 'QA', color: '#e05fa8', capacity: 8 })
    assert(m3.deskId === 'B4', 'remaining desk')
    await rejects(source.createMember({ name: '넷째', role: 'QA', color: '#e05fa8', capacity: 8 }), '자리가 모두 찼어요', 'team full', 'conflict')

    // updateMember
    await rejects(source.updateMember(m.id, { deskId: first.deskId }), '이미 사용 중인 자리예요', 'move to taken desk')
    await rejects(source.updateMember('nope', { name: 'x' }), '팀원', 'unknown member', 'not_found')
    await rejects(source.updateMember(m.id, { capacity: 100 }), '여유량', 'capacity patch')
    const same = await source.updateMember(m.id, { deskId: m.deskId, name: '신입 2' })
    assert(same.name === '신입 2' && same.deskId === m.deskId, 'keeping own desk is fine')
    changes.length = 0
    const moved = await source.updateMember(m3.id, { presence: 'break' })
    assert(moved.presence === 'break' && changes.length === 2, 'presence update')

    // deleteMember → backlog
    const rec0 = Object.fromEntries((await source.load()).tasks.map((t) => [t.id, t]))
    const victim = ws.members[1] // overloaded one: has in_progress + done tasks
    const victimOpen = Object.values(rec0).filter((t) => t.assigneeId === victim.id && t.status !== 'done')
    const victimDone = Object.values(rec0).filter((t) => t.assigneeId === victim.id && t.status === 'done')
    assert(victimOpen.length > 0 && victimDone.length > 0, 'victim has open and done tasks')
    changes.length = 0
    await source.deleteMember(victim.id, { mode: 'backlog' })
    const afterA = await source.load()
    checkInvariants(afterA, 'delete->backlog')
    assert(!afterA.members.some((x) => x.id === victim.id), 'member removed')
    for (const t of victimOpen) {
      const cur = afterA.tasks.find((x) => x.id === t.id)!
      assert(cur.assigneeId === null && cur.status === 'todo', `moved to backlog as todo (${cur.status})`)
    }
    for (const t of victimDone) assert(afterA.tasks.find((x) => x.id === t.id)!.assigneeId === null && afterA.tasks.find((x) => x.id === t.id)!.status === 'done', 'done tasks unassigned, still done')
    const idxDel = changes.findIndex((c) => c.type === 'member_delete')
    const lastUpsert = changes.map((c) => c.type).lastIndexOf('task_upsert')
    assert(idxDel > lastUpsert && changes[changes.length - 1].type === 'activity', 'task upserts, then member_delete, then activity')
    assert(changes.filter((c) => c.type === 'task_upsert').length === victimOpen.length + victimDone.length, 'upsert for every moved task')

    // deleteMember → other member
    const from = ws.members[3]
    const to = ws.members[4]
    const fromOpen = afterA.tasks.filter((t) => t.assigneeId === from.id && t.status !== 'done')
    await rejects(source.deleteMember(from.id, { mode: 'member', memberId: from.id }), '같은 팀원', 'same member', 'invalid')
    await rejects(source.deleteMember(from.id, { mode: 'member', memberId: 'nope' }), '팀원', 'missing target')
    await rejects(source.deleteMember('nope', { mode: 'backlog' }), '팀원', 'unknown member delete', 'not_found')
    await source.deleteMember(from.id, { mode: 'member', memberId: to.id })
    const afterB = await source.load()
    checkInvariants(afterB, 'delete->member')
    for (const t of fromOpen) {
      const cur = afterB.tasks.find((x) => x.id === t.id)!
      assert(cur.assigneeId === to.id && cur.status === t.status, 'reassigned with status kept')
    }
    const orders = afterB.tasks.filter((t) => t.assigneeId === to.id).map((t) => t.order)
    assert(new Set(orders).size === orders.length, 'orders unique on target stack')
    console.log('members ok')
  }

  // ---- persistence -------------------------------------------------------------
  {
    const a = open()
    const ws = await a.source.load()
    const t = await a.source.createTask({ title: '저장 확인', projectId: ws.projects[1].id })
    await a.source.updateMember(ws.members[2].id, { capacity: 21 })
    await sleep(260) // debounce
    const b = open({ storage: a.storage, seed: 7 })
    const ws2 = await b.source.load()
    assert(ws2.tasks.some((x) => x.id === t.id && x.title === '저장 확인'), 'persisted task visible to a new source')
    assert(ws2.members.find((m) => m.id === ws.members[2].id)!.capacity === 21, 'persisted member update')
    const t3 = await b.source.createTask({ title: '두번째', projectId: ws.projects[0].id })
    assert(t3.number === t.number + 1, 'nextNumber persisted')
    checkInvariants(ws2, 'persisted')

    // reset flushes immediately and emits nothing
    b.changes.length = 0
    const fresh = await b.source.reset!()
    assert(b.changes.length === 0, 'reset emits nothing')
    assert(fresh.tasks.length === 36 && !fresh.tasks.some((x) => x.title === '두번째'), 'reset reseeds')
    const c = open({ storage: a.storage })
    assert((await c.source.load()).tasks.length === 36, 'reset persisted immediately')

    // flush hook
    const d = open()
    await d.source.createTask({ title: 'flush', projectId: (await d.source.load()).projects[0].id })
    d.handle.flush()
    assert(JSON.parse(d.storage.getItem(STORAGE_KEY)!).workspace.tasks.length === 37, 'flush writes now')

    // corrupt storage -> reseed
    const bad: (string | ((s: ReturnType<typeof createMemoryStorage>) => void))[] = [
      '{not json',
      '[]',
      JSON.stringify({ version: 2, workspace: {}, nextNumber: 1 }),
      JSON.stringify({ version: 1, workspace: { projects: [], members: [], tasks: [], activity: [] }, nextNumber: 1 }),
    ]
    for (const raw of bad) {
      const st = createMemoryStorage()
      st.setItem(STORAGE_KEY, raw as string)
      const x = open({ storage: st })
      const w = await x.source.load()
      assert(w.tasks.length === 36 && w.members.length === 7, `corrupt storage reseeds: ${String(raw).slice(0, 30)}`)
    }
    // corrupt data: raw string is backed up and the reseed is announced
    for (const raw of bad) {
      const st = createMemoryStorage()
      st.setItem(STORAGE_KEY, raw as string)
      const w = await open({ storage: st }).source.load()
      assert(st.getItem(CORRUPT_KEY) === raw, 'corrupt raw string backed up')
      assert(w.activity[w.activity.length - 1].message === '저장된 데이터를 불러오지 못해 초기화했어요' && w.activity[w.activity.length - 1].kind === 'system', 'reseed activity (kind system)')
    }
    // missing storage is a normal first run: no backup, no notice
    {
      const st = createMemoryStorage()
      const w = await open({ storage: st }).source.load()
      assert(st.getItem(CORRUPT_KEY) === null && !w.activity.some((x) => x.message.includes('초기화')), 'first run is silent')
    }
    // fixable damage is repaired field by field instead of wiping everything
    {
      const st = createMemoryStorage()
      await open({ storage: st }).source.load()
      const raw = JSON.parse(st.getItem(STORAGE_KEY)!)
      const ws0: Workspace = raw.workspace
      ws0.tasks[0].assigneeId = 'ghost'
      ;(ws0.tasks[1] as { estimate: number }).estimate = 4
      ws0.tasks[2].dueDate = 'soon'
      ws0.members[0].capacity = 99
      ws0.members[1].deskId = ws0.members[0].deskId
      ws0.members[2].deskId = 'Q1'
      ws0.tasks[5].completedAt = null // done without completedAt
      ;(ws0.tasks[6] as { priority: string }).priority = 'wow'
      ws0.tasks.push({ ...ws0.tasks[3], id: 'dup-number' }) // duplicate number
      ws0.tasks.push({ nonsense: true } as unknown as Task)
      raw.nextNumber = 2
      st.setItem(STORAGE_KEY, JSON.stringify(raw))
      const w = await open({ storage: st }).source.load()
      checkInvariants(w, 'repaired')
      assert(w.members.length === 7, 'members kept')
      assert(w.tasks.length === 37, `tasks kept, garbage dropped (got ${w.tasks.length})`)
      assert(w.tasks[0].assigneeId === null && w.tasks[1].estimate === 3 && w.tasks[2].dueDate === null, 'task fields repaired')
      assert(w.tasks[6].priority === 'medium' && w.tasks[5].completedAt !== null, 'priority / completedAt repaired')
      assert(w.members[0].capacity === 40, 'capacity clamped')
      assert(new Set(w.members.map((m) => m.deskId)).size === 7, 'desks made unique')
      assert(w.tasks.find((x) => x.id === 'dup-number')!.number > 36, 'duplicate number renumbered')
      assert(st.getItem(CORRUPT_KEY) !== null, 'repaired data backed up first')
      assert(w.activity[w.activity.length - 1].message === '저장된 데이터 일부를 바로잡았어요' && w.activity[w.activity.length - 1].kind === 'system', 'repair activity (kind system)')
    }
    // storage that throws
    const throwing = { getItem: () => { throw new Error('x') }, setItem: () => { throw new Error('x') }, removeItem: () => { throw new Error('x') } }
    const e = createMockDataSourceForTest({ storage: throwing, latencyMs: [0, 0] })
    const w = await e.source.load()
    await e.source.createTask({ title: '저장 실패', projectId: w.projects[0].id })
    console.log('persistence ok')
  }

  // ---- latency option + listener hygiene ------------------------------------
  {
    const h = createMockDataSourceForTest({ storage: createMemoryStorage(), latencyMs: [30, 30] })
    const t0 = Date.now()
    await h.source.load()
    assert(Date.now() - t0 >= 25, 'latency applied')
    const seen: Change[] = []
    const off = h.source.subscribe((c) => seen.push(c))
    const w = await h.source.load()
    await h.source.createTask({ title: 'a', projectId: w.projects[0].id })
    const n = seen.length
    off()
    await h.source.createTask({ title: 'b', projectId: w.projects[0].id })
    assert(seen.length === n && n === 2, 'unsubscribe works')
    // a throwing listener must not break others
    let ok = 0
    h.source.subscribe(() => { throw new Error('boom') })
    h.source.subscribe(() => void ok++)
    const origErr = console.error
    console.error = () => {}
    await h.source.createTask({ title: 'c', projectId: w.projects[0].id })
    console.error = origErr
    assert(ok === 2, 'throwing listener isolated')
    // listeners get copies
    let leaked: Task | null = null
    const h2 = createMockDataSourceForTest({ storage: createMemoryStorage(), latencyMs: [0, 0] })
    h2.source.subscribe((c) => { if (c.type === 'task_upsert') { c.task.title = 'HACKED'; leaked = c.task } })
    const w2 = await h2.source.load()
    await h2.source.updateTask(w2.tasks[0].id, { priority: 'low' })
    assert(leaked !== null && (await h2.source.load()).tasks[0].title !== 'HACKED', 'change payloads are copies')
    console.log('latency / listeners ok')
  }

  // ---- demo mode ---------------------------------------------------------------
  {
    const rand = mulberry32(99)
    let clock = Date.now()
    const now = () => new Date(clock)
    const { handle, source, changes } = open({ seed: 42, now })
    const actions: Record<string, number> = {}
    const seenPresence = new Set<string>()
    let maxBacklog = 0
    let peakNonWorking = 0
    let silentDeletes = 0
    let feedRows = 0
    const t0 = clock
    for (let i = 0; i < 500; i++) {
      clock += 8000 + rand() * 7000 // the real cadence: one tick every 8-15 s
      changes.length = 0
      const name = handle.demoTick()
      actions[name ?? 'none'] = (actions[name ?? 'none'] ?? 0) + 1
      const ws = await source.load()
      if (i % 5 === 0 || i > 480) checkInvariants(ws, `demo tick ${i}`)
      const acts = changes.filter((c) => c.type === 'activity').length
      feedRows += acts
      assert(acts <= 1, 'at most one activity per tick')
      const deleted = changes.filter((c) => c.type === 'task_delete').length
      if (deleted > 0) {
        silentDeletes += deleted
        assert(!changes.some((c) => c.type === 'activity' && c.activity.kind === 'task_deleted'), 'housekeeping is silent')
        for (const c of changes) if (c.type === 'task_delete') assert(c.id.startsWith('td_'), 'only demo-created tasks are pruned')
      }
      if (name && ['done', 'take', 'incoming', 'meeting'].includes(name)) assert(acts === 1, `${name} always shows in the feed`)
      if (name && ['start', 'review', 'done', 'take', 'incoming'].includes(name)) assert(changes.some((c) => c.type === 'task_upsert'), `${name} emits an upsert`)
      for (const m of ws.members) seenPresence.add(m.presence)
      const rec = Object.fromEntries(ws.tasks.map((t) => [t.id, t]))
      maxBacklog = Math.max(maxBacklog, backlogTasks(rec).length)
      peakNonWorking = Math.max(peakNonWorking, ws.members.filter((m) => m.presence !== 'working').length)
      assert(ws.members.filter((m) => m.presence === 'working').length >= Math.ceil(ws.members.length / 2), 'at least half the team working')
      assert(ws.tasks.filter((t) => t.status === 'done' && t.id.startsWith('td_')).length <= 40, 'demo-created done tasks capped at 40')
      for (const m of ws.members) {
        assert(ws.tasks.filter((t) => t.assigneeId === m.id && t.status === 'in_progress').length <= 2, 'max 2 in progress per member')
      }
    }
    const minutes = (clock - t0) / 60000
    const feedPerMin = feedRows / minutes
    assert(feedPerMin <= 4.2, `feed noise ${feedPerMin.toFixed(2)} rows/min should be <= ~4`)
    const ws = await source.load()
    checkInvariants(ws, 'demo end')
    const rec = Object.fromEntries(ws.tasks.map((t) => [t.id, t]))
    const status = (s: string) => ws.tasks.filter((t) => t.status === s).length
    assert(['start', 'review', 'done', 'take', 'incoming', 'meeting', 'break'].every((a) => (actions[a] ?? 0) > 0), `all main actions occurred: ${JSON.stringify(actions)}`)
    assert(seenPresence.has('meeting') && seenPresence.has('break'), 'meeting and break occurred')
    assert(maxBacklog <= 11, `backlog stays small (max ${maxBacklog})`)
    assert(status('todo') + status('in_progress') + status('review') > 8, 'team keeps having work')
    assert(silentDeletes > 0, 'housekeeping removed old demo-created done tasks')
    assert(ws.tasks.filter((t) => !t.id.startsWith('td_') && t.status === 'done').length >= 10, 'seed done tasks are never pruned')
    const msgs = ws.activity.slice(-6).map((a) => a.message)
    assert(msgs.every((m) => /[가-힣]/.test(m)), 'Korean messages')
    handle.flush()
    console.log(`demo ok: actions ${JSON.stringify(actions)}`)
    console.log(`  feed ${feedPerMin.toFixed(2)} rows/min over ${minutes.toFixed(0)} simulated min; end state: todo ${status('todo')}, in_progress ${status('in_progress')}, review ${status('review')}, done ${status('done')}, backlog ${backlogTasks(rec).length}; peak non-working ${peakNonWorking}`)
    console.log(`  last messages: ${msgs.join(' | ')}`)

    // setDemoMode is idempotent and cheap
    const h = createMockDataSourceForTest({ storage: createMemoryStorage(), latencyMs: [0, 0] })
    for (let i = 0; i < 20; i++) h.source.setDemoMode!(i % 3 !== 0)
    h.source.setDemoMode!(false)
    h.source.setDemoMode!(false)
  }

  // ---- manager-touch protection ------------------------------------------------
  {
    let clock = Date.now()
    const { handle, source } = open({ seed: 11, now: () => new Date(clock) })
    const ws0 = await source.load()
    // The manager touches every open task (no-op edits count) and sets a member to 'break'.
    for (const t of ws0.tasks.filter((x) => x.status !== 'done')) await source.updateTask(t.id, { estimate: t.estimate })
    const breaker = ws0.members.find((m) => m.presence === 'working')!
    await source.updateMember(breaker.id, { presence: 'break' })
    const meetingMember = ws0.members.find((m) => m.presence === 'meeting')!
    await source.updateMember(meetingMember.id, { presence: 'meeting' }) // no-op, still a manager decision
    const snap = JSON.stringify((await source.load()).tasks.filter((t) => t.id.startsWith('t_')))
    for (let i = 0; i < 9; i++) {
      clock += 10_000 // 90 s total, inside the 2 minute window
      handle.demoTick()
      handle.returnTick()
      const now = await source.load()
      assert(JSON.stringify(now.tasks.filter((t) => t.id.startsWith('t_'))) === snap, 'demo leaves manager-touched tasks alone')
      assert(now.members.find((m) => m.id === breaker.id)!.presence === 'break', 'demo keeps the manager-set break')
      assert(now.members.find((m) => m.id === meetingMember.id)!.presence === 'meeting', 'demo keeps the manager-set meeting')
    }
    // after the window everything is fair game again
    clock += 60_000
    let moved = false
    for (let i = 0; i < 60 && !moved; i++) {
      clock += 10_000
      handle.demoTick()
      handle.returnTick()
      const now = await source.load()
      moved = JSON.stringify(now.tasks.filter((t) => t.id.startsWith('t_'))) !== snap
    }
    assert(moved, 'after the window demo works on those tasks again')
    let end = await source.load()
    for (let i = 0; i < 20 && end.members.find((m) => m.id === breaker.id)!.presence !== 'working'; i++) {
      clock += 10_000
      handle.demoTick()
      handle.returnTick()
      end = await source.load()
    }
    assert(end.members.find((m) => m.id === breaker.id)!.presence === 'working', 'manager-set break ends after the window')

    // user-created tasks are never deleted by housekeeping, even when done
    const second = open({ seed: 12, now: () => new Date(clock) })
    const w2 = await second.source.load()
    const mine: string[] = []
    for (let i = 0; i < 60; i++) mine.push((await second.source.createTask({ title: `내 작업 ${i}`, projectId: w2.projects[0].id, status: 'done' })).id)
    for (let i = 0; i < 400; i++) {
      clock += 12_000
      second.handle.demoTick()
    }
    const after = await second.source.load()
    assert(mine.every((id) => after.tasks.some((t) => t.id === id)), 'user-created done tasks survive housekeeping')
    assert(after.tasks.filter((t) => t.id.startsWith('td_') && t.status === 'done').length <= 40, 'demo done tasks still pruned')
    console.log('manager-touch protection ok')
  }

  // ---- nobody stays stuck ------------------------------------------------------
  {
    let clock = Date.now()
    const { handle, source } = open({ seed: 21, now: () => new Date(clock) })
    await source.load()
    source.setDemoMode!(true)
    let ws: Workspace = await source.load()
    for (let i = 0; i < 400 && ws.members.filter((m) => m.presence !== 'working').length < 2; i++) {
      clock += 5000
      handle.demoTick()
      ws = await source.load()
    }
    const away = ws.members.filter((m) => m.presence !== 'working').length
    assert(away >= 2, 'someone is away/in a meeting before demo stops')
    source.setDemoMode!(false) // a real stop
    clock += 120_000 // longer than any meeting / break / away
    handle.returnTick()
    ws = await source.load()
    assert(ws.members.every((m) => m.presence === 'working'), 'after stopping demo everyone comes back')

    // persisted meeting/break/away with no timer: back to work shortly after load, demo off
    const st = createMemoryStorage()
    const a = open({ storage: st, now: () => new Date(clock) })
    const seeded = await a.source.load()
    await a.source.updateMember(seeded.members[0].id, { presence: 'away' })
    a.handle.flush()
    clock += 5 * 60_000 // long after the manager's own change
    const b = open({ storage: st, now: () => new Date(clock) })
    const loaded = await b.source.load()
    const stuck = loaded.members.filter((m) => m.presence !== 'working').length
    assert(stuck >= 3, `seed meeting + break + away persisted (${stuck})`)
    clock += 20_000
    b.handle.returnTick()
    const back = await b.source.load()
    assert(back.members.every((m) => m.presence === 'working'), 'persisted non-working members return after load')
    console.log('no-stuck members ok')
  }

  // ---- cross-tab sync ----------------------------------------------------------
  {
    const hub = createSharedMemoryStorage()
    const a = open({ storage: hub.view(), seed: 1 })
    const b = open({ storage: hub.view(), seed: 2 })
    const wsA = await a.source.load()
    await b.source.load()
    a.changes.length = 0
    b.changes.length = 0

    const t = await a.source.createTask({ title: '탭 A에서 만든 작업', projectId: wsA.projects[0].id, assigneeId: wsA.members[0].id })
    await a.source.updateTask(wsA.tasks[0].id, { priority: 'urgent' })
    a.handle.flush()
    const upserts = b.changes.map((c) => (c.type === 'task_upsert' ? c.task.id : ''))
    assert(upserts.includes(t.id) && upserts.includes(wsA.tasks[0].id), 'tab B receives the upserts')
    assert(b.changes.some((c) => c.type === 'activity' && c.activity.message.includes('새 작업')), 'tab B receives the activity')
    assert((await b.source.load()).tasks.some((x) => x.id === t.id), 'tab B state converged')
    const aChangesBefore = a.changes.length
    b.changes.length = 0

    await a.source.deleteTask(t.id)
    const m = await a.source.createMember({ name: '탭 신입', role: 'QA', color: '#3a6df0', capacity: 8 })
    await a.source.deleteMember(wsA.members[2].id, { mode: 'backlog' })
    a.handle.flush()
    assert(b.changes.some((c) => c.type === 'task_delete' && c.id === t.id), 'tab B receives the delete')
    assert(b.changes.some((c) => c.type === 'member_upsert' && c.member.id === m.id), 'tab B receives the new member')
    assert(b.changes.some((c) => c.type === 'member_delete' && c.id === wsA.members[2].id), 'tab B receives the member removal')
    const stA = await a.source.load()
    const stB = await b.source.load()
    assert(JSON.stringify(stA.tasks) === JSON.stringify(stB.tasks) && JSON.stringify(stA.members) === JSON.stringify(stB.members), 'both tabs hold the same workspace')
    checkInvariants(stB, 'tab B after sync')
    assert(a.changes.length > aChangesBefore && a.changes.length < aChangesBefore + 12, 'no echo storm back to tab A')

    // B continues from the adopted state (numbers keep increasing, nothing overwritten)
    const t2 = await b.source.createTask({ title: '탭 B에서 이어서', projectId: wsA.projects[0].id })
    b.handle.flush()
    const stA2 = await a.source.load()
    assert(stA2.tasks.some((x) => x.id === t2.id), 'tab A sees the task created in tab B')
    assert(stA2.tasks.filter((x) => x.number === t2.number).length === 1, 'numbers stay unique across tabs')
    console.log('cross-tab sync ok')
  }

  // ---- cross-tab: pending saves are merged, never dropped ---------------------
  {
    // The reviewer's probe: A assigns, B creates 50 ms later, A's save lands inside B's debounce window.
    const hub = createSharedMemoryStorage()
    const a = open({ storage: hub.view(), seed: 1, demo: false })
    const b = open({ storage: hub.view(), seed: 2, demo: false })
    const wsA = await a.source.load()
    await b.source.load()
    const target = wsA.tasks.find((t) => t.assigneeId === null && t.status === 'todo')!
    const owner = wsA.members[4]
    await a.source.updateTask(target.id, { assigneeId: owner.id })
    await sleep(50)
    const made = await b.source.createTask({ title: 'B가 50ms 뒤에 만든 작업', projectId: wsA.projects[0].id })
    await sleep(450) // A's save (~200 ms) lands before B's (~250 ms)
    const stored: Workspace = JSON.parse(hub.view().getItem(STORAGE_KEY)!).workspace
    for (const [label, ws] of [['A', await a.source.load()], ['B', await b.source.load()], ['storage', stored]] as const) {
      assert(ws.tasks.find((t) => t.id === target.id)?.assigneeId === owner.id, `${label}: A's assignment survived`)
      assert(ws.tasks.some((t) => t.id === made.id), `${label}: B's new task survived`)
      checkInvariants(ws, `probe ${label}`)
    }

    // Both tabs create a task at the same moment: both survive, numbers stay unique, nextNumber moves on.
    const [ta, tb] = await Promise.all([
      a.source.createTask({ title: '동시에 만든 A', projectId: wsA.projects[0].id }),
      b.source.createTask({ title: '동시에 만든 B', projectId: wsA.projects[1].id }),
    ])
    assert(ta.number === tb.number, 'both tabs handed out the same number before syncing')
    await sleep(500)
    const after: Workspace = JSON.parse(hub.view().getItem(STORAGE_KEY)!).workspace
    const nextNumber: number = JSON.parse(hub.view().getItem(STORAGE_KEY)!).nextNumber
    assert(after.tasks.some((t) => t.id === ta.id) && after.tasks.some((t) => t.id === tb.id), 'both concurrent tasks stored')
    checkInvariants(after, 'concurrent create')
    assert(nextNumber > Math.max(...after.tasks.map((t) => t.number)), 'nextNumber above every task number')
    const viewA = await a.source.load()
    const viewB = await b.source.load()
    assert(JSON.stringify(viewA.tasks.map((t) => [t.id, t.number]).sort()) === JSON.stringify(viewB.tasks.map((t) => [t.id, t.number]).sort()), 'tabs agree on numbers')
    // the listeners of the tab whose task was renumbered were told
    const renumbered = a.changes.concat(b.changes).filter((c) => c.type === 'task_upsert' && (c.task.id === ta.id || c.task.id === tb.id))
    assert(renumbered.length >= 3, 'renumbering is emitted as an upsert')

    // A deletion in one tab and an edit of another task in the other tab both stick
    const victim = after.tasks.find((t) => t.status === 'done')!
    const edited = after.tasks.find((t) => t.status === 'todo' && t.id !== target.id)!
    await a.source.deleteTask(victim.id)
    await sleep(30)
    await b.source.updateTask(edited.id, { priority: 'urgent' })
    await sleep(450)
    const fin: Workspace = JSON.parse(hub.view().getItem(STORAGE_KEY)!).workspace
    assert(!fin.tasks.some((t) => t.id === victim.id), 'deletion stuck')
    assert(fin.tasks.find((t) => t.id === edited.id)!.priority === 'urgent', 'edit stuck')
    console.log('cross-tab merge ok')
  }

  // ---- demo leader: only one tab ticks -----------------------------------------
  {
    let clock = Date.now()
    const now = () => new Date(clock)
    const hub = createSharedMemoryStorage()
    const a = open({ storage: hub.view(), seed: 1, now })
    const b = open({ storage: hub.view(), seed: 2, now })
    await a.source.load()
    await b.source.load()
    assert(a.handle.isLeader() && !b.handle.isLeader(), 'first tab leads, second waits')
    clock += 1000
    assert(b.handle.demoTick() === null, 'non-leader does not tick')
    let acted = false
    for (let i = 0; i < 20 && !acted; i++) {
      clock += 5000
      a.handle.leaderTick()
      acted = a.handle.demoTick() !== null
    }
    assert(acted, 'leader ticks')
    b.handle.returnTick() // no-op for a follower
    // leader steps down (no wish, no pending returns) -> the follower takes over at once
    for (let i = 0; i < 20; i++) {
      clock += 30_000
      a.handle.leaderTick()
      a.handle.returnTick()
    }
    a.source.setDemoMode!(false)
    assert(!a.handle.isLeader() && b.handle.isLeader(), 'follower takes over when the leader stops')
    let bActed = false
    for (let i = 0; i < 10 && !bActed; i++) {
      clock += 5000
      bActed = b.handle.demoTick() !== null
    }
    assert(bActed, 'new leader ticks')
    assert(a.handle.demoTick() === null, 'old leader no longer ticks')

    // crashed leader: no heartbeat for > 8 s -> the other tab takes over
    const hub2 = createSharedMemoryStorage()
    const c = open({ storage: hub2.view(), seed: 3, now })
    const d = open({ storage: hub2.view(), seed: 4, now })
    await c.source.load()
    await d.source.load()
    assert(c.handle.isLeader() && !d.handle.isLeader(), 'c leads')
    clock += 5000
    d.handle.leaderTick()
    assert(!d.handle.isLeader(), 'lease still alive after 5 s')
    clock += 4000 // 9 s without a heartbeat from c
    d.handle.leaderTick()
    assert(d.handle.isLeader(), 'd takes over a dead lease')
    c.handle.leaderTick()
    assert(!c.handle.isLeader(), 'c yields to the live lease')

    // Web Locks path: first holder leads, the lock moves on when it steps down
    const locks = createFakeLocks()
    const hub3 = createSharedMemoryStorage()
    const e = open({ storage: hub3.view(), seed: 5, now, locks, demo: false })
    const f = open({ storage: hub3.view(), seed: 6, now, locks, demo: false })
    e.source.setDemoMode!(true)
    f.source.setDemoMode!(true)
    await sleep(5)
    assert(e.handle.isLeader() && !f.handle.isLeader(), 'web locks: one leader')
    const w = await e.source.load() // books default returns for the seed members: still has duty
    void w
    for (let i = 0; i < 10; i++) {
      clock += 30_000
      e.handle.returnTick()
    }
    e.source.setDemoMode!(false)
    await sleep(5)
    assert(!e.handle.isLeader() && f.handle.isLeader(), 'web locks: lock handed over')
    console.log('demo leader ok')
  }

  // ---- manager touches protect tasks across tabs ---------------------------------
  {
    let clock = Date.now()
    const now = () => new Date(clock)
    const hub = createSharedMemoryStorage()
    const lead = open({ storage: hub.view(), seed: 31, now })
    const other = open({ storage: hub.view(), seed: 32, now })
    const ws = await lead.source.load()
    await other.source.load()
    assert(lead.handle.isLeader() && !other.handle.isLeader(), 'lead tab runs demo')
    const snap = JSON.stringify(ws.tasks.filter((t) => t.status !== 'done'))
    // the manager in the OTHER tab touches every open task
    for (const t of ws.tasks.filter((x) => x.status !== 'done')) await other.source.updateTask(t.id, { estimate: t.estimate })
    for (let i = 0; i < 9; i++) {
      clock += 10_000
      lead.handle.leaderTick()
      lead.handle.demoTick()
      const cur = await lead.source.load()
      assert(JSON.stringify(cur.tasks.filter((t) => ws.tasks.some((x) => x.id === t.id && x.status !== 'done'))) === snap, "tab B's touches protect tasks from tab A's demo")
    }
    // touches are persisted with a timestamp and expire
    const meta = JSON.parse(hub.view().getItem(META_KEY)!)
    assert(Object.keys(meta.touches).some((k) => k.startsWith('task:')), 'touch timestamps persisted')
    clock += 130_000
    lead.handle.leaderTick()
    let moved = false
    for (let i = 0; i < 60 && !moved; i++) {
      clock += 10_000
      lead.handle.leaderTick()
      lead.handle.demoTick()
      moved = JSON.stringify((await lead.source.load()).tasks.filter((t) => ws.tasks.some((x) => x.id === t.id && x.status !== 'done'))) !== snap
    }
    assert(moved, 'after expiry the demo works on them again')
    console.log('cross-tab touch protection ok')
  }

  // ---- planned returns survive tabs ------------------------------------------------
  {
    let clock = Date.now()
    const now = () => new Date(clock)
    const hub = createSharedMemoryStorage()
    const a = open({ storage: hub.view(), seed: 41, now })
    await a.source.load()
    // let the seed's own stuck members come back first
    clock += 60_000
    a.handle.leaderTick()
    a.handle.returnTick()
    let started = false
    for (let i = 0; i < 1500 && !started; i++) {
      clock += 12_000
      a.handle.leaderTick()
      started = a.handle.demoTick() === 'meeting'
    }
    assert(started, 'demo started a meeting')
    const inMeeting = (await a.source.load()).members.filter((m) => m.presence === 'meeting').map((m) => m.id)
    assert(inMeeting.length >= 2, 'a meeting is running')
    a.handle.flush()
    // another tab opens now: it must honour the planned return (20-40 s), not book its own 8-15 s one
    const b = open({ storage: hub.view(), seed: 42, now })
    await b.source.load()
    clock += 17_000
    a.handle.leaderTick()
    b.handle.leaderTick()
    a.handle.returnTick()
    b.handle.returnTick()
    const mid = await a.source.load()
    assert(inMeeting.every((id) => mid.members.find((m) => m.id === id)?.presence === 'meeting'), 'meeting not cut short by another tab')
    clock += 30_000
    a.handle.leaderTick()
    a.handle.returnTick()
    a.handle.flush()
    const end = await a.source.load()
    assert(inMeeting.every((id) => end.members.find((m) => m.id === id)?.presence === 'working'), 'meeting members return at their planned time')
    const viaB = await b.source.load()
    assert(inMeeting.every((id) => viaB.members.find((m) => m.id === id)?.presence === 'working'), 'the other tab sees them back')
    console.log('planned returns ok')
  }

  // ---- demo state persists and reloads cleanly --------------------------------
  {
    let clock = Date.now()
    const storage = createMemoryStorage()
    const first = open({ storage, seed: 5, now: () => new Date(clock) })
    for (let i = 0; i < 80; i++) {
      clock += 10_000
      first.handle.demoTick()
    }
    first.handle.flush()
    const second = open({ storage, seed: 6, now: () => new Date(clock) })
    const ws = await second.source.load()
    checkInvariants(ws, 'reloaded after demo')
    const before = await first.source.load()
    assert(JSON.stringify(ws.tasks) === JSON.stringify(before.tasks), 'reload equals state before')
    console.log('demo persistence ok')
  }

  console.log(`\nALL OK (${checks} checks)`)
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  },
)
