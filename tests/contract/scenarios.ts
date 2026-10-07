// Shared contract scenarios: the same expectations run against the mock source and the API source.
// Not a *.test.ts file itself; mock.test.ts and api.test.ts call defineContractSuite().
import assert from 'node:assert/strict'
import { beforeEach, afterEach, describe, it } from 'node:test'
import { DataError, type DataErrorCode, type DataSource } from '../../src/data/DataSource'
import type { Activity, Change, Meeting, Member, MemberInput, Task, TaskInput, Workspace } from '../../src/data/types'

export interface SourceHandle {
  source: DataSource
  /** Called after each scenario: abort streams, close servers' per-test state. */
  dispose(): Promise<void> | void
}

export interface Collector {
  /** Data changes only; link-state `connection` changes go to `connections`. */
  changes: Change[]
  connections: string[]
  clear(): void
  /** Resolves when a change matching `pred` has arrived (pushed changes may trail the response). */
  until(pred: (c: Change) => boolean, label: string, ms?: number): Promise<Change>
  /** Waits a short moment so a "nothing should arrive" check is meaningful. */
  settle(ms?: number): Promise<void>
  off(): void
}

export function collect(source: DataSource): Collector {
  const changes: Change[] = []
  const connections: string[] = []
  const off = source.subscribe((c) => {
    if (c.type === 'connection') connections.push(c.status)
    else changes.push(c)
  })
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  return {
    changes,
    connections,
    clear: () => void (changes.length = 0),
    async until(pred, label, ms = 4000) {
      const t0 = Date.now()
      for (;;) {
        const hit = changes.find(pred)
        if (hit) return hit
        if (Date.now() - t0 > ms) {
          assert.fail(`timed out waiting for change: ${label}\nreceived: ${JSON.stringify(changes.map((c) => (c.type === 'activity' ? `activity:${c.activity.message}` : c.type)))}`)
        }
        await sleep(10)
      }
    },
    settle: (ms = 150) => sleep(ms),
    off,
  }
}

export async function rejectsWith(p: Promise<unknown>, code: DataErrorCode, message: string, label: string) {
  try {
    await p
  } catch (e) {
    assert.ok(e instanceof DataError, `${label}: expected DataError, got ${String(e)}`)
    assert.equal((e as DataError).code, code, `${label}: code`)
    assert.equal((e as Error).message, message, `${label}: message`)
    return
  }
  assert.fail(`${label}: expected a rejection`)
}

/** For rules whose exact message is not pinned down by docs/API.md: only the code must match. */
export async function rejectsCode(p: Promise<unknown>, code: DataErrorCode, label: string) {
  try {
    await p
  } catch (e) {
    assert.ok(e instanceof DataError, `${label}: expected DataError, got ${String(e)}`)
    assert.equal((e as DataError).code, code, `${label}: code`)
    assert.ok((e as Error).message.length > 0, `${label}: has a message`)
    return
  }
  assert.fail(`${label}: expected a rejection`)
}

const isUpsert = (id: string) => (c: Change) => c.type === 'task_upsert' && c.task.id === id
const isActivity = (pred: (a: Activity) => boolean) => (c: Change) => c.type === 'activity' && pred(c.activity)
const indexOfChange = (changes: Change[], pred: (c: Change) => boolean) => changes.findIndex(pred)

function checkWorkspace(ws: Workspace, label: string) {
  const memberIds = new Set(ws.members.map((m) => m.id))
  assert.equal(memberIds.size, ws.members.length, `${label}: unique member ids`)
  const desks = ws.members.map((m) => m.deskId)
  assert.equal(new Set(desks).size, desks.length, `${label}: unique desks`)
  const projectIds = new Set(ws.projects.map((p) => p.id))
  const numbers = ws.tasks.map((t) => t.number)
  assert.equal(new Set(numbers).size, numbers.length, `${label}: unique task numbers`)
  for (const t of ws.tasks) {
    assert.ok(t.assigneeId === null || memberIds.has(t.assigneeId), `${label}: no orphan assignee (${t.id})`)
    assert.ok(projectIds.has(t.projectId), `${label}: project exists`)
    assert.equal(t.status === 'done', t.completedAt !== null, `${label}: done <=> completedAt (${t.id})`)
  }
  assert.ok(ws.activity.length <= 100, `${label}: activity capped`)
  const taskIds = new Set(ws.tasks.map((t) => t.id))
  assert.ok(ws.meetings.filter((m) => m.status === 'ongoing').length <= 1, `${label}: at most one ongoing meeting`)
  assert.ok(ws.meetings.filter((m) => m.status === 'ended').length <= 20, `${label}: at most 20 ended meetings`)
  for (const t of ws.tasks) assert.ok(!(t.onAgenda && t.status === 'done'), `${label}: done tasks are not on the agenda (${t.id})`)
  for (const m of ws.meetings.filter((x) => x.status === 'ongoing')) {
    for (const id of m.agendaTaskIds) assert.ok(taskIds.has(id), `${label}: ongoing agenda refers to existing tasks`)
    for (const id of m.attendeeIds) assert.ok(memberIds.has(id), `${label}: ongoing meeting refers to existing members`)
  }
}

const byNumber = (ws: Workspace, n: number): Task => ws.tasks.find((t) => t.number === n)!
const upsertOf = (changes: Change[], id: string) => changes.filter((x) => x.type === 'task_upsert' && x.task.id === id) as Extract<Change, { type: 'task_upsert' }>[]
const meetingUpserts = (changes: Change[]) => changes.filter((x) => x.type === 'meeting_upsert') as Extract<Change, { type: 'meeting_upsert' }>[]

export function defineContractSuite(name: string, create: () => Promise<SourceHandle>) {
  describe(`contract: ${name}`, () => {
    let handle: SourceHandle
    let source: DataSource
    let ws: Workspace
    let c: Collector

    beforeEach(async () => {
      handle = await create()
      source = handle.source
      ws = await source.load()
      c = collect(source)
    })
    afterEach(async () => {
      c.off()
      await handle.dispose()
    })

    it('load returns a well-formed workspace', () => {
      assert.equal(source.label.length > 0, true)
      assert.equal(ws.projects.length, 3)
      assert.equal(ws.members.length, 7)
      assert.equal(ws.tasks.length, 36)
      assert.deepEqual(ws.tasks.map((t) => t.number).sort((a, b) => a - b), Array.from({ length: 36 }, (_, i) => i + 1))
      assert.ok(ws.activity.length > 0)
      checkWorkspace(ws, 'seed')
      for (const t of ws.tasks) {
        assert.match(t.createdAt, /^\d{4}-\d{2}-\d{2}T/)
        assert.ok(t.dueDate === null || /^\d{4}-\d{2}-\d{2}$/.test(t.dueDate))
      }
    })

    it('task lifecycle: create, assign, complete, reopen, delete (entities and pushed changes)', async () => {
      const member = ws.members[4]
      const topOrder = Math.max(0, ...ws.tasks.filter((t) => t.assigneeId === member.id).map((t) => t.order))

      c.clear()
      const created = await source.createTask({ title: '  계약 테스트 작업  ', projectId: ws.projects[0].id })
      assert.equal(created.title, '계약 테스트 작업')
      assert.equal(created.status, 'todo')
      assert.equal(created.priority, 'medium')
      assert.equal(created.estimate, 3)
      assert.equal(created.description, '')
      assert.equal(created.dueDate, null)
      assert.equal(created.assigneeId, null)
      assert.equal(created.completedAt, null)
      assert.equal(created.number, 37)
      assert.equal(typeof created.id, 'string')
      const backlogTop = Math.max(0, ...ws.tasks.filter((t) => t.assigneeId === null).map((t) => t.order))
      assert.ok(created.order > backlogTop, 'new task goes on top of the backlog')
      await c.until(isUpsert(created.id), 'task_upsert (create)')
      const createdActivity = (await c.until(isActivity((a) => a.taskId === created.id), 'activity (create)')) as Extract<Change, { type: 'activity' }>
      assert.equal(createdActivity.activity.kind, 'task_created')
      assert.equal(createdActivity.activity.actorId, null)
      assert.equal(createdActivity.activity.message, '새 작업 WEB-37을 만들었어요')
      assert.ok(indexOfChange(c.changes, isUpsert(created.id)) < indexOfChange(c.changes, isActivity((a) => a.taskId === created.id)), 'upsert precedes its activity')

      c.clear()
      const assigned = await source.updateTask(created.id, { assigneeId: member.id })
      assert.equal(assigned.assigneeId, member.id)
      assert.ok(assigned.order > topOrder, 'assigned task lands on top of the stack')
      await c.until(isUpsert(created.id), 'task_upsert (assign)')
      const assignAct = (await c.until(isActivity((a) => a.kind === 'task_assigned'), 'activity (assign)')) as Extract<Change, { type: 'activity' }>
      assert.equal(assignAct.activity.message, `WEB-37 '계약 테스트 작업'을 ${member.name} 님에게 배정했어요`)

      c.clear()
      const started = await source.updateTask(created.id, { status: 'in_progress' })
      assert.equal(started.status, 'in_progress')
      assert.equal(started.completedAt, null)
      await c.until(isActivity((a) => a.kind === 'task_status'), 'activity (status)')

      c.clear()
      const done = await source.updateTask(created.id, { status: 'done' })
      assert.equal(done.status, 'done')
      assert.ok(done.completedAt !== null, 'done sets completedAt')
      assert.ok(done.updatedAt >= started.updatedAt)
      const doneChange = (await c.until(isUpsert(created.id), 'task_upsert (done)')) as Extract<Change, { type: 'task_upsert' }>
      assert.equal(doneChange.task.completedAt, done.completedAt)

      const reopened = await source.updateTask(created.id, { status: 'todo' })
      assert.equal(reopened.completedAt, null, 'leaving done clears completedAt')

      c.clear()
      await source.deleteTask(created.id)
      await c.until((x) => x.type === 'task_delete' && x.id === created.id, 'task_delete')
      await c.until(isActivity((a) => a.kind === 'task_deleted'), 'activity (delete)')
      const after = await source.load()
      assert.ok(!after.tasks.some((t) => t.id === created.id), 'task is gone')
      // numbers are never reused
      const next = await source.createTask({ title: '다음 작업', projectId: ws.projects[1].id, assigneeId: member.id, status: 'in_progress', estimate: 5, priority: 'urgent', dueDate: '2030-01-31' })
      assert.equal(next.number, 38)
      assert.equal(next.estimate, 5)
      assert.equal(next.priority, 'urgent')
      assert.equal(next.dueDate, '2030-01-31')
      assert.equal(next.assigneeId, member.id)
    })

    it('updating only an order or content field keeps the rest intact', async () => {
      const t = ws.tasks.find((x) => x.status === 'todo' && x.assigneeId !== null)!
      const updated = await source.updateTask(t.id, { title: '  새 제목  ', description: '설명', priority: 'low', estimate: 8, dueDate: null, order: 999 })
      assert.equal(updated.title, '새 제목')
      assert.equal(updated.description, '설명')
      assert.equal(updated.priority, 'low')
      assert.equal(updated.estimate, 8)
      assert.equal(updated.dueDate, null)
      assert.equal(updated.order, 999)
      assert.equal(updated.assigneeId, t.assigneeId)
      assert.equal(updated.number, t.number)
      assert.equal(updated.createdAt, t.createdAt)
      await c.until(isActivity((a) => a.kind === 'task_updated'), 'activity (update)')
    })

    it('unassigning sends the task back to the backlog stack', async () => {
      const t = ws.tasks.find((x) => x.status === 'in_progress' && x.assigneeId !== null)!
      const updated = await source.updateTask(t.id, { assigneeId: null })
      assert.equal(updated.assigneeId, null)
      const backlogTop = Math.max(0, ...ws.tasks.filter((x) => x.assigneeId === null).map((x) => x.order))
      assert.ok(updated.order > backlogTop)
      await c.until(isActivity((a) => a.kind === 'task_assigned' && a.message.endsWith('백로그로 돌렸어요')), 'activity (to backlog)')
    })

    it('validation errors carry the same code and message', async () => {
      const project = ws.projects[0].id
      const bad = (input: Partial<TaskInput>) => ({ title: 'ok', projectId: project, ...input }) as TaskInput
      await rejectsWith(source.createTask(bad({ title: '   ' })), 'invalid', '제목을 입력해 주세요', 'empty title')
      await rejectsWith(source.createTask(bad({ title: 'x'.repeat(121) })), 'invalid', '제목은 120자 이하로 입력해 주세요', 'long title')
      await rejectsWith(source.createTask(bad({ projectId: 'nope' })), 'invalid', '프로젝트를 찾을 수 없어요', 'unknown project')
      await rejectsWith(source.createTask(bad({ assigneeId: 'nope' })), 'invalid', '팀원을 찾을 수 없어요', 'unknown assignee')
      await rejectsWith(source.createTask(bad({ estimate: 4 as never })), 'invalid', '예상 포인트가 올바르지 않아요', 'estimate')
      await rejectsWith(source.createTask(bad({ priority: 'wow' as never })), 'invalid', '올바르지 않은 우선순위예요', 'priority')
      await rejectsWith(source.createTask(bad({ status: 'nope' as never })), 'invalid', '올바르지 않은 상태예요', 'status')
      await rejectsWith(source.createTask(bad({ dueDate: '2030-02-31' })), 'invalid', '마감일 형식이 올바르지 않아요', 'due date')
      const t = ws.tasks[10]
      await rejectsWith(source.updateTask(t.id, { title: '' }), 'invalid', '제목을 입력해 주세요', 'update empty title')
      await rejectsWith(source.updateTask(t.id, { assigneeId: 'nope' }), 'invalid', '팀원을 찾을 수 없어요', 'update unknown assignee')
      await rejectsWith(source.updateTask(t.id, { projectId: 'nope' }), 'invalid', '프로젝트를 찾을 수 없어요', 'update unknown project')
      await rejectsWith(source.updateTask(t.id, { estimate: 7 as never }), 'invalid', '예상 포인트가 올바르지 않아요', 'update estimate')
      const m: MemberInput = { name: '신입', role: '백엔드', color: '#3a6df0', capacity: 8 }
      await rejectsWith(source.createMember({ ...m, name: '  ' }), 'invalid', '이름을 입력해 주세요', 'empty name')
      await rejectsWith(source.createMember({ ...m, name: 'x'.repeat(31) }), 'invalid', '이름은 30자 이하로 입력해 주세요', 'long name')
      await rejectsWith(source.createMember({ ...m, capacity: 0 }), 'invalid', '주간 여유량은 1~40 사이로 입력해 주세요', 'capacity 0')
      await rejectsWith(source.createMember({ ...m, capacity: 41 }), 'invalid', '주간 여유량은 1~40 사이로 입력해 주세요', 'capacity 41')
      await rejectsWith(source.createMember({ ...m, deskId: 'Z9' }), 'invalid', '존재하지 않는 자리예요', 'unknown desk')
      await rejectsWith(source.updateMember(ws.members[0].id, { capacity: 100 }), 'invalid', '주간 여유량은 1~40 사이로 입력해 주세요', 'update capacity')
      // nothing leaked out of the failed calls
      await c.settle()
      assert.equal(c.changes.length, 0, 'rejected calls push no changes')
      assert.equal((await source.load()).tasks.length, ws.tasks.length)
    })

    it('unknown ids are not_found', async () => {
      await rejectsWith(source.updateTask('nope', { title: 'x' }), 'not_found', '작업을 찾을 수 없어요', 'update task')
      await rejectsWith(source.deleteTask('nope'), 'not_found', '작업을 찾을 수 없어요', 'delete task')
      await rejectsWith(source.updateMember('nope', { name: 'x' }), 'not_found', '팀원을 찾을 수 없어요', 'update member')
      await rejectsWith(source.deleteMember('nope', { mode: 'backlog' }), 'not_found', '팀원을 찾을 수 없어요', 'delete member')
    })

    it('members: create, update, desk conflicts, team full', async () => {
      const first = ws.members[0]
      c.clear()
      const m = await source.createMember({ name: ' 신입  ', role: '백엔드', color: '#3a6df0', capacity: 8 })
      assert.equal(m.name, '신입')
      assert.equal(m.presence, 'working')
      assert.equal(m.deskId, 'A5', 'first free desk')
      assert.ok(m.avatarVariant >= 0)
      await c.until((x) => x.type === 'member_upsert' && x.member.id === m.id, 'member_upsert')
      await c.until(isActivity((a) => a.kind === 'member_joined' && a.message === '신입 님이 합류했어요'), 'activity (joined)')

      await rejectsWith(source.createMember({ name: 'a', role: 'x', color: '#3a6df0', capacity: 8, deskId: first.deskId }), 'conflict', '이미 사용 중인 자리예요', 'desk taken')
      await rejectsWith(source.updateMember(m.id, { deskId: first.deskId }), 'conflict', '이미 사용 중인 자리예요', 'move to a taken desk')
      const same = await source.updateMember(m.id, { deskId: m.deskId, name: '신입 2', capacity: 12, role: 'QA' })
      assert.equal(same.name, '신입 2')
      assert.equal(same.capacity, 12)
      assert.equal(same.role, 'QA')
      const moved = await source.updateMember(m.id, { deskId: 'B5' })
      assert.equal(moved.deskId, 'B5')
      const away = await source.updateMember(m.id, { presence: 'break' })
      assert.equal(away.presence, 'break')

      const second = await source.createMember({ name: '둘째', role: '디자인', color: '#e05fa8', capacity: 8, deskId: 'A5' })
      assert.equal(second.deskId, 'A5')
      const third = await source.createMember({ name: '셋째', role: 'QA', color: '#e05fa8', capacity: 8 })
      assert.equal(third.deskId, 'B4')
      assert.equal((await source.load()).members.length, 10)
      await rejectsWith(source.createMember({ name: '넷째', role: 'QA', color: '#e05fa8', capacity: 8 }), 'conflict', '자리가 모두 찼어요', 'team full')
      checkWorkspace(await source.load(), 'after members')
    })

    it('deleteMember to the backlog: open tasks become unassigned todo, done tasks lose their assignee', async () => {
      const victim = ws.members[1]
      const open = ws.tasks.filter((t) => t.assigneeId === victim.id && t.status !== 'done')
      const done = ws.tasks.filter((t) => t.assigneeId === victim.id && t.status === 'done')
      assert.ok(open.length > 0 && done.length > 0)
      c.clear()
      await source.deleteMember(victim.id, { mode: 'backlog' })
      await c.until((x) => x.type === 'member_delete' && x.id === victim.id, 'member_delete')
      await c.until(isActivity((a) => a.kind === 'member_left'), 'activity (left)')
      const after = await source.load()
      checkWorkspace(after, 'after delete->backlog')
      assert.ok(!after.members.some((m) => m.id === victim.id))
      for (const t of open) {
        const cur = after.tasks.find((x) => x.id === t.id)!
        assert.equal(cur.assigneeId, null)
        assert.equal(cur.status, 'todo')
      }
      for (const t of done) {
        const cur = after.tasks.find((x) => x.id === t.id)!
        assert.equal(cur.assigneeId, null)
        assert.equal(cur.status, 'done')
      }
      // pushed order: every moved task upsert, then member_delete, then the activity
      const types = c.changes.map((x) => x.type)
      const del = types.indexOf('member_delete')
      assert.equal(types.filter((t) => t === 'task_upsert').length, open.length + done.length)
      assert.ok(types.lastIndexOf('task_upsert') < del, 'task upserts before member_delete')
      assert.ok(types.indexOf('activity') > del, 'activity after member_delete')
      const left = c.changes.find((x) => x.type === 'activity') as Extract<Change, { type: 'activity' }>
      assert.equal(left.activity.message, `${victim.name} 님이 팀을 떠나 작업 ${open.length}개를 백로그로 옮겼어요`)
    })

    it('deleteMember to another member keeps statuses and stacks them on top', async () => {
      const from = ws.members[3]
      const to = ws.members[4]
      const open = ws.tasks.filter((t) => t.assigneeId === from.id && t.status !== 'done')
      await rejectsWith(source.deleteMember(from.id, { mode: 'member', memberId: from.id }), 'invalid', '같은 팀원에게는 넘길 수 없어요', 'same member')
      await rejectsWith(source.deleteMember(from.id, { mode: 'member', memberId: 'nope' }), 'invalid', '작업을 넘겨받을 팀원을 찾을 수 없어요', 'unknown target')
      assert.ok((await source.load()).members.some((m) => m.id === from.id), 'failed calls keep the member')
      await source.deleteMember(from.id, { mode: 'member', memberId: to.id })
      const after = await source.load()
      checkWorkspace(after, 'after delete->member')
      for (const t of open) {
        const cur = after.tasks.find((x) => x.id === t.id)!
        assert.equal(cur.assigneeId, to.id)
        assert.equal(cur.status, t.status)
      }
      const orders = after.tasks.filter((t) => t.assigneeId === to.id).map((t) => t.order)
      assert.equal(new Set(orders).size, orders.length, 'orders unique on the target stack')
      const oldTop = Math.max(0, ...ws.tasks.filter((t) => t.assigneeId === to.id).map((t) => t.order))
      for (const t of open) assert.ok(after.tasks.find((x) => x.id === t.id)!.order > oldTop)
    })

    it('the client sees changes for its own mutations, in order, with matching entities', async () => {
      c.clear()
      const t = await source.createTask({ title: '변경 확인', projectId: ws.projects[2].id })
      const u = await source.updateTask(t.id, { priority: 'high' })
      await source.deleteTask(t.id)
      await c.until((x) => x.type === 'task_delete' && x.id === t.id, 'delete')
      const mine = c.changes.filter((x) => (x.type === 'task_upsert' && x.task.id === t.id) || (x.type === 'task_delete' && x.id === t.id))
      assert.deepEqual(mine.map((x) => x.type), ['task_upsert', 'task_upsert', 'task_delete'])
      const first = mine[0] as Extract<Change, { type: 'task_upsert' }>
      const second = mine[1] as Extract<Change, { type: 'task_upsert' }>
      assert.deepEqual(first.task, t)
      assert.deepEqual(second.task, u)
    })

    // ---- agenda + meetings (roadmap A1) -----------------------------------------------

    it('seed: every task has onAgenda, exactly two open tasks are on the agenda, no meetings yet', () => {
      for (const t of ws.tasks) assert.equal(typeof t.onAgenda, 'boolean', `onAgenda on ${t.id}`)
      const agenda = ws.tasks.filter((t) => t.onAgenda)
      assert.deepEqual(agenda.map((t) => t.number).sort((a, b) => a - b), [20, 35])
      assert.ok(agenda.every((t) => t.status !== 'done'))
      assert.deepEqual(ws.meetings, [])
    })

    it('agenda: toggle on and off, new tasks start off, completing clears it, done tasks are rejected', async () => {
      const t = byNumber(ws, 31)
      assert.equal(t.onAgenda, false)
      c.clear()
      const on = await source.updateTask(t.id, { onAgenda: true })
      assert.equal(on.onAgenda, true)
      assert.equal(on.title, t.title, 'only the given field changes')
      assert.equal(on.status, t.status)
      assert.equal(on.assigneeId, t.assigneeId)
      const upsert = (await c.until(isUpsert(t.id), 'task_upsert (agenda on)')) as Extract<Change, { type: 'task_upsert' }>
      assert.equal(upsert.task.onAgenda, true)
      assert.equal(upsert.task.number, 31)
      assert.ok((await source.load()).tasks.find((x) => x.id === t.id)!.onAgenda)

      const off = await source.updateTask(t.id, { onAgenda: false })
      assert.equal(off.onAgenda, false)

      const fresh = await source.createTask({ title: '안건 없는 새 작업', projectId: ws.projects[0].id })
      assert.equal(fresh.onAgenda, false, 'created tasks start off the agenda')

      await rejectsWith(source.updateTask(t.id, { onAgenda: 'yes' as never }), 'invalid', '안건 값이 올바르지 않아요', 'non-boolean onAgenda')

      // completing a task takes it off the agenda by itself
      await source.updateTask(t.id, { onAgenda: true })
      const finished = await source.updateTask(t.id, { status: 'done' })
      assert.equal(finished.status, 'done')
      assert.equal(finished.onAgenda, false, 'completing clears onAgenda')

      // done tasks cannot be put on the agenda
      await rejectsWith(source.updateTask(t.id, { onAgenda: true }), 'invalid', '완료된 작업은 안건으로 올릴 수 없어요', 'agenda on a done task')
      const seedDone = byNumber(ws, 1)
      await rejectsWith(source.updateTask(seedDone.id, { onAgenda: true }), 'invalid', '완료된 작업은 안건으로 올릴 수 없어요', 'agenda on a seed done task')
      assert.equal((await source.load()).tasks.find((x) => x.id === seedDone.id)!.onAgenda, false)
      // taking it off is always fine, reopening and then adding works
      await source.updateTask(t.id, { onAgenda: false })
      await source.updateTask(t.id, { status: 'todo' })
      assert.equal((await source.updateTask(t.id, { onAgenda: true })).onAgenda, true)
    })

    it('startMeeting: validation errors, then agenda captured in priority order and attendees move to the meeting room', async () => {
      const [m1, m2, m3, , , m6] = ws.members
      const attendeeIds = [m1.id, m3.id, m6.id]
      await rejectsWith(source.startMeeting({ title: '   ', attendeeIds }), 'invalid', '회의 이름을 입력해 주세요', 'empty title')
      await rejectsWith(source.startMeeting({ title: '가'.repeat(61), attendeeIds }), 'invalid', '회의 이름은 60자 이하로 입력해 주세요', 'long title')
      await rejectsWith(source.startMeeting({ title: '회의', attendeeIds: [] }), 'invalid', '참석자를 한 명 이상 골라 주세요', 'no attendees')
      await rejectsCode(source.startMeeting({ title: '회의', attendeeIds: [m1.id, 'nope'] }), 'invalid', 'unknown attendee')
      await rejectsWith(source.startMeeting({ title: '회의', attendeeIds: [m1.id, m1.id] }), 'invalid', '같은 참석자가 여러 번 들어 있어요', 'duplicate attendee')
      await c.settle()
      assert.equal(c.changes.length, 0, 'rejected starts push nothing')
      assert.deepEqual((await source.load()).meetings, [], 'rejected starts leave no meeting')
      assert.equal((await source.load()).members.find((m) => m.id === m1.id)!.presence, 'working', 'rejected starts move nobody')

      // seed agenda is #20 (high) and #35 (urgent); add #14 (urgent, lower number) and a low-priority one
      await source.updateTask(byNumber(ws, 14).id, { onAgenda: true })
      await source.updateTask(byNumber(ws, 34).id, { onAgenda: true })
      c.clear()
      const meeting = await source.startMeeting({ title: '  스프린트 계획  ', attendeeIds })
      assert.equal(meeting.title, '스프린트 계획')
      assert.equal(typeof meeting.id, 'string')
      assert.equal(meeting.status, 'ongoing')
      assert.deepEqual(meeting.attendeeIds, attendeeIds)
      assert.deepEqual(meeting.agendaTaskIds, [byNumber(ws, 14).id, byNumber(ws, 35).id, byNumber(ws, 20).id, byNumber(ws, 34).id], 'priority desc, then number')
      assert.equal(meeting.endedAt, null)
      assert.match(meeting.startedAt, /^\d{4}-\d{2}-\d{2}T/)
      assert.equal(meeting.notes, '')
      assert.deepEqual(meeting.outcomes, [])

      // pushed: member_upsert for every attendee (presence meeting), meeting_upsert, one meeting_started activity
      const act = (await c.until(isActivity((a) => a.kind === 'meeting_started'), 'activity (meeting_started)')) as Extract<Change, { type: 'activity' }>
      assert.equal(act.activity.actorId, null)
      assert.equal(act.activity.message, '스프린트 계획을 시작했어요 · 참석 3명 · 안건 4건')
      const memberUpserts = c.changes.filter((x) => x.type === 'member_upsert') as Extract<Change, { type: 'member_upsert' }>[]
      assert.deepEqual(memberUpserts.map((x) => x.member.id).sort(), [...attendeeIds].sort(), 'one upsert per attendee, even one already in a meeting')
      assert.ok(memberUpserts.every((x) => x.member.presence === 'meeting'))
      const pushed = meetingUpserts(c.changes)
      assert.equal(pushed.length, 1)
      assert.deepEqual(pushed[0].meeting, meeting)
      assert.equal(c.changes.filter((x) => x.type === 'activity').length, 1, 'exactly one activity')
      const iMeeting = indexOfChange(c.changes, (x) => x.type === 'meeting_upsert')
      assert.ok(memberUpserts.every((x) => indexOfChange(c.changes, (y) => y === x) < iMeeting), 'member upserts precede the meeting upsert')
      assert.ok(iMeeting < indexOfChange(c.changes, isActivity((a) => a.kind === 'meeting_started')), 'meeting upsert precedes its activity')

      const after = await source.load()
      assert.deepEqual(after.meetings, [meeting])
      for (const id of attendeeIds) assert.equal(after.members.find((m) => m.id === id)!.presence, 'meeting')
      assert.equal(after.members.find((m) => m.id === m2.id)!.presence, 'working', 'non-attendees stay put')
      checkWorkspace(after, 'ongoing meeting')

      // only one meeting at a time (validation still comes first)
      await rejectsWith(source.startMeeting({ title: '또 회의', attendeeIds: [m2.id] }), 'conflict', '이미 회의가 진행 중이에요', 'second start')
      await rejectsWith(source.startMeeting({ title: '   ', attendeeIds: [m2.id] }), 'invalid', '회의 이름을 입력해 주세요', 'validation before conflict')
      assert.equal((await source.load()).members.find((m) => m.id === m2.id)!.presence, 'working', 'a rejected start moves nobody')

      // the returned meeting is a copy
      meeting.title = 'MUTATED'
      assert.equal((await source.load()).meetings[0].title, '스프린트 계획')
    })

    it('endMeeting: every outcome kind is applied atomically, keep stays on the agenda, attendees go back to work', async () => {
      const [m1, , m3, , m5, m6] = ws.members
      const t14 = byNumber(ws, 14) // urgent, in_progress, m7 -> done
      const t35 = byNumber(ws, 35) // urgent, backlog -> assign m5
      const t20 = byNumber(ws, 20) // high, in_progress, m6 -> backlog
      const t32 = byNumber(ws, 32) // high, backlog todo -> status in_progress
      const t31 = byNumber(ws, 31) // medium -> keep
      const t34 = byNumber(ws, 34) // low -> no outcome (counts as keep)
      for (const t of [t14, t32, t31, t34]) await source.updateTask(t.id, { onAgenda: true })
      const attendeeIds = [m1.id, m3.id, m6.id]
      const meeting = await source.startMeeting({ title: '스프린트 계획', attendeeIds })
      assert.deepEqual(meeting.agendaTaskIds, [t14.id, t35.id, t20.id, t32.id, t31.id, t34.id], 'urgent by number, high by number, medium, low')
      const stackTop = Math.max(0, ...ws.tasks.filter((t) => t.assigneeId === m5.id).map((t) => t.order))
      const backlogTop = Math.max(0, ...ws.tasks.filter((t) => t.assigneeId === null).map((t) => t.order))

      await c.settle() // pushes of the start may trail its response
      c.clear()
      const outcomes: Meeting['outcomes'] = [
        { taskId: t35.id, action: 'assign', memberId: m5.id },
        { taskId: t14.id, action: 'status', status: 'done' },
        { taskId: t20.id, action: 'backlog' },
        { taskId: t32.id, action: 'status', status: 'in_progress' },
        { taskId: t31.id, action: 'keep' },
      ]
      const ended = await source.endMeeting(meeting.id, { notes: '  결정 사항 정리  ', outcomes })
      assert.equal(ended.id, meeting.id)
      assert.equal(ended.status, 'ended')
      assert.ok(ended.endedAt !== null && ended.endedAt >= ended.startedAt)
      assert.equal(ended.notes, '  결정 사항 정리  ', 'notes are stored as written')
      assert.deepEqual(ended.outcomes, outcomes)
      assert.deepEqual(ended.agendaTaskIds, meeting.agendaTaskIds)
      assert.deepEqual(ended.attendeeIds, attendeeIds)

      const after = await source.load()
      checkWorkspace(after, 'after meeting')
      const g = (n: number) => after.tasks.find((t) => t.number === n)!
      assert.equal(g(35).assigneeId, m5.id)
      assert.ok(g(35).order > stackTop, 'assigned task lands on top of the stack')
      assert.equal(g(35).status, 'todo')
      assert.equal(g(14).status, 'done')
      assert.ok(g(14).completedAt !== null)
      assert.equal(g(20).assigneeId, null)
      assert.equal(g(20).status, 'todo', 'in_progress goes back to todo on the backlog')
      assert.ok(g(20).order > backlogTop)
      assert.equal(g(32).status, 'in_progress')
      assert.equal(g(32).assigneeId, null, 'a status outcome does not change the assignee')
      for (const n of [35, 14, 20, 32]) assert.equal(g(n).onAgenda, false, `#${n} leaves the agenda`)
      assert.equal(g(31).onAgenda, true, 'keep stays on the agenda')
      assert.equal(g(34).onAgenda, true, 'no outcome counts as keep')
      assert.equal(g(31).status, t31.status, 'keep changes nothing else')
      assert.deepEqual(after.meetings, [ended])
      for (const id of attendeeIds) assert.equal(after.members.find((m) => m.id === id)!.presence, 'working', 'attendees are back at their desks')

      // pushed: task upserts for decided tasks only, member upserts for the people who moved, meeting_upsert, one activity
      const act = (await c.until(isActivity((a) => a.kind === 'meeting_ended'), 'activity (meeting_ended)')) as Extract<Change, { type: 'activity' }>
      assert.equal(act.activity.actorId, null)
      assert.equal(act.activity.message, '스프린트 계획이 끝났어요 · 결정 4건', 'keep is not a decision')
      for (const n of [35, 14, 20, 32]) {
        const ups = upsertOf(c.changes, byNumber(ws, n).id)
        assert.equal(ups.length, 1, `one upsert for #${n}`)
        assert.equal(ups[0].task.onAgenda, false)
      }
      assert.equal(upsertOf(c.changes, t31.id).length, 0, 'kept task is untouched')
      assert.equal(upsertOf(c.changes, t34.id).length, 0, 'undecided task is untouched')
      const memberUpserts = c.changes.filter((x) => x.type === 'member_upsert') as Extract<Change, { type: 'member_upsert' }>[]
      assert.deepEqual(memberUpserts.map((x) => x.member.id).sort(), [...attendeeIds].sort())
      assert.ok(memberUpserts.every((x) => x.member.presence === 'working'))
      const pushed = meetingUpserts(c.changes)
      assert.equal(pushed.length, 1)
      assert.deepEqual(pushed[0].meeting, ended)
      assert.equal(c.changes.filter((x) => x.type === 'activity').length, 1, 'exactly one activity')
      const iMeeting = indexOfChange(c.changes, (x) => x.type === 'meeting_upsert')
      assert.ok(c.changes.every((x, i) => (x.type === 'task_upsert' || x.type === 'member_upsert' ? i < iMeeting : true)), 'task/member upserts precede the meeting upsert')
      assert.ok(iMeeting < indexOfChange(c.changes, isActivity((a) => a.kind === 'meeting_ended')))

      // an ended meeting cannot end again, and the next meeting picks the kept tasks up again
      await rejectsWith(source.endMeeting(meeting.id, { notes: '', outcomes: [] }), 'conflict', '이미 끝난 회의예요', 'end twice')
      await rejectsWith(source.endMeeting('nope', { notes: '', outcomes: [] }), 'not_found', '회의를 찾을 수 없어요', 'unknown meeting')
      const next = await source.startMeeting({ title: '다음 회의', attendeeIds: [m1.id] })
      assert.deepEqual(next.agendaTaskIds, [t31.id, t34.id], 'kept tasks are on the next agenda')
      const list = (await source.load()).meetings
      assert.deepEqual(list.map((m) => m.id), [meeting.id, next.id], 'ended first, ongoing last')
    })

    it('endMeeting: validation errors change nothing, and an end with no outcomes keeps the whole agenda', async () => {
      const [m1, m2] = ws.members
      const t35 = byNumber(ws, 35)
      const t20 = byNumber(ws, 20)
      const stranger = byNumber(ws, 12) // exists, but not on the agenda
      const meeting = await source.startMeeting({ title: '검증 회의', attendeeIds: [m1.id, m2.id] })
      assert.deepEqual(meeting.agendaTaskIds, [t35.id, t20.id])
      await c.settle()
      c.clear()
      const end = (outcomes: Meeting['outcomes'], notes = '') => source.endMeeting(meeting.id, { notes, outcomes })
      await rejectsWith(end([], 'x'.repeat(2001)), 'invalid', '회의록은 2000자 이하로 입력해 주세요', 'notes too long')
      await rejectsWith(end([{ taskId: stranger.id, action: 'keep' }]), 'invalid', '안건에 없는 작업이에요', 'task not on the agenda')
      await rejectsWith(end([{ taskId: t35.id, action: 'keep' }, { taskId: t35.id, action: 'backlog' }]), 'invalid', '같은 작업에 결정이 여러 개 있어요', 'two outcomes for one task')
      await rejectsCode(end([{ taskId: t35.id, action: 'assign', memberId: 'nope' }]), 'invalid', 'assign to an unknown member')
      await rejectsWith(end([{ taskId: t35.id, action: 'status', status: 'nope' as never }]), 'invalid', '올바르지 않은 상태예요', 'unknown status')
      await rejectsWith(end([{ taskId: t35.id, action: 'nope' as never } as never]), 'invalid', '올바르지 않은 결정이에요', 'unknown action')
      await c.settle()
      assert.equal(c.changes.length, 0, 'rejected ends push nothing')
      const mid = await source.load()
      assert.equal(mid.meetings[0].status, 'ongoing')
      assert.equal(byNumber(mid, 35).assigneeId, null)
      assert.equal(byNumber(mid, 35).onAgenda, true)
      assert.equal(mid.members.find((m) => m.id === m1.id)!.presence, 'meeting')

      // notes of exactly 2000 chars are fine; no outcomes = everything stays on the agenda
      const ended = await end([], 'n'.repeat(2000))
      assert.equal(ended.status, 'ended')
      assert.equal(ended.notes.length, 2000)
      assert.deepEqual(ended.outcomes, [])
      const after = await source.load()
      assert.equal(byNumber(after, 35).onAgenda, true)
      assert.equal(byNumber(after, 20).onAgenda, true)
      assert.equal(after.members.find((m) => m.id === m1.id)!.presence, 'working')
    })

    it('assigning an agenda task to its current assignee keeps its place in the stack', async () => {
      const [m1] = ws.members
      const mine = ws.tasks.filter((t) => t.assigneeId === m1.id && t.status !== 'done').sort((a, b) => a.order - b.order)
      const lower = mine[0] // not the top of the stack
      assert.ok(mine.length > 1)
      await source.updateTask(lower.id, { onAgenda: true })
      const meeting = await source.startMeeting({ title: '순서 회의', attendeeIds: [m1.id] })
      await source.endMeeting(meeting.id, { notes: '', outcomes: [{ taskId: lower.id, action: 'assign', memberId: m1.id }] })
      const after = (await source.load()).tasks.find((t) => t.id === lower.id)!
      assert.equal(after.assigneeId, m1.id)
      assert.equal(after.order, lower.order, 'same assignee: order untouched')
      assert.equal(after.onAgenda, false)
    })

    it('a task deleted during the meeting leaves the agenda; an outcome for it is skipped silently', async () => {
      const [m1, m2] = ws.members
      const t35 = byNumber(ws, 35)
      const t20 = byNumber(ws, 20)
      const meeting = await source.startMeeting({ title: '삭제 회의', attendeeIds: [m1.id, m2.id] })
      assert.deepEqual(meeting.agendaTaskIds, [t35.id, t20.id])
      await c.settle()
      c.clear()
      await source.deleteTask(t35.id)
      await c.until((x) => x.type === 'task_delete' && x.id === t35.id, 'task_delete')
      const upsert = (await c.until((x) => x.type === 'meeting_upsert' && x.meeting.agendaTaskIds.length === 1, 'meeting_upsert (agenda shrinks)')) as Extract<Change, { type: 'meeting_upsert' }>
      assert.equal(upsert.meeting.id, meeting.id)
      assert.deepEqual(upsert.meeting.agendaTaskIds, [t20.id])
      assert.deepEqual(upsert.meeting.attendeeIds, [m1.id, m2.id])
      assert.deepEqual((await source.load()).meetings[0].agendaTaskIds, [t20.id])

      c.clear()
      // the client may still have sent a decision for the task that was just deleted
      const ended = await source.endMeeting(meeting.id, {
        notes: '',
        outcomes: [
          { taskId: t35.id, action: 'backlog' },
          { taskId: t20.id, action: 'status', status: 'review' },
        ],
      })
      assert.deepEqual(ended.agendaTaskIds, [t20.id])
      assert.deepEqual(ended.outcomes, [{ taskId: t20.id, action: 'status', status: 'review' }], 'the outcome of the deleted task is dropped from the record')
      const act = (await c.until(isActivity((a) => a.kind === 'meeting_ended'), 'activity (meeting_ended)')) as Extract<Change, { type: 'activity' }>
      assert.equal(act.activity.message, '삭제 회의가 끝났어요 · 결정 1건', 'the dropped outcome is not counted')
      const after = await source.load()
      assert.equal(byNumber(after, 20).status, 'review')
      assert.equal(byNumber(after, 20).onAgenda, false)
      assert.ok(!after.tasks.some((t) => t.id === t35.id))
      assert.equal(upsertOf(c.changes, t35.id).length, 0, 'nothing is resurrected')
      checkWorkspace(after, 'after delete + end')
    })

    it('outcomes apply to tasks completed during the meeting; an outcome that changes nothing writes nothing', async () => {
      const [m1] = ws.members
      const t14 = byNumber(ws, 14)
      const t35 = byNumber(ws, 35)
      const t20 = byNumber(ws, 20)
      await source.updateTask(t14.id, { onAgenda: true })
      const meeting = await source.startMeeting({ title: '완료 회의', attendeeIds: [m1.id] })
      assert.deepEqual(meeting.agendaTaskIds, [t14.id, t35.id, t20.id])
      // two agenda tasks get completed while the meeting runs (completing takes them off the agenda)
      const done14 = await source.updateTask(t14.id, { status: 'done' })
      const done35 = await source.updateTask(t35.id, { status: 'done' })
      assert.equal(done14.onAgenda, false)
      await c.settle()
      c.clear()
      const outcomes: Meeting['outcomes'] = [
        { taskId: t14.id, action: 'status', status: 'todo' }, // reopens it
        { taskId: t35.id, action: 'status', status: 'done' }, // already so: nothing to write
        { taskId: t20.id, action: 'keep' },
      ]
      const ended = await source.endMeeting(meeting.id, { notes: '', outcomes })
      assert.deepEqual(ended.outcomes, outcomes)
      const act = (await c.until(isActivity((a) => a.kind === 'meeting_ended'), 'activity (meeting_ended)')) as Extract<Change, { type: 'activity' }>
      assert.equal(act.activity.message, '완료 회의가 끝났어요 · 결정 2건')
      const after = await source.load()
      const reopened = after.tasks.find((t) => t.id === t14.id)!
      assert.equal(reopened.status, 'todo', 'a status outcome reopens a task completed meanwhile')
      assert.equal(reopened.completedAt, null)
      assert.equal(reopened.onAgenda, false)
      assert.equal(upsertOf(c.changes, t14.id).length, 1)
      const untouched = after.tasks.find((t) => t.id === t35.id)!
      assert.equal(untouched.status, 'done')
      assert.equal(untouched.completedAt, done35.completedAt)
      assert.equal(untouched.updatedAt, done35.updatedAt, 'a no-op outcome does not bump updatedAt')
      assert.equal(upsertOf(c.changes, t35.id).length, 0, 'a no-op outcome emits nothing')
      assert.equal(upsertOf(c.changes, t20.id).length, 0, 'keep emits nothing')
      checkWorkspace(after, 'after completing during the meeting')
    })

    it('a member removed during the meeting leaves the attendee list', async () => {
      const [m1, m2, m3] = ws.members
      const meeting = await source.startMeeting({ title: '이탈 회의', attendeeIds: [m1.id, m2.id, m3.id] })
      await c.settle()
      c.clear()
      await source.deleteMember(m2.id, { mode: 'backlog' })
      await c.until((x) => x.type === 'member_delete' && x.id === m2.id, 'member_delete')
      const upsert = (await c.until((x) => x.type === 'meeting_upsert' && x.meeting.attendeeIds.length === 2, 'meeting_upsert (attendees shrink)')) as Extract<Change, { type: 'meeting_upsert' }>
      assert.equal(upsert.meeting.id, meeting.id)
      assert.deepEqual(upsert.meeting.attendeeIds, [m1.id, m3.id])
      assert.deepEqual(upsert.meeting.agendaTaskIds, meeting.agendaTaskIds, 'the agenda is unchanged')
      const mid = await source.load()
      assert.deepEqual(mid.meetings[0].attendeeIds, [m1.id, m3.id])
      checkWorkspace(mid, 'after member left')

      const ended = await source.endMeeting(meeting.id, { notes: '', outcomes: [] })
      assert.deepEqual(ended.attendeeIds, [m1.id, m3.id])
      const after = await source.load()
      for (const id of [m1.id, m3.id]) assert.equal(after.members.find((m) => m.id === id)!.presence, 'working')
      checkWorkspace(after, 'after end')
    })

    it('an attendee the manager sent on a break during the meeting stays on that break at the end', async () => {
      const [m1, m2] = ws.members
      const meeting = await source.startMeeting({ title: '휴식 회의', attendeeIds: [m1.id, m2.id] })
      await source.updateMember(m2.id, { presence: 'break' })
      await c.settle()
      c.clear()
      await source.endMeeting(meeting.id, { notes: '', outcomes: [] })
      await c.until(isActivity((a) => a.kind === 'meeting_ended'), 'activity (meeting_ended)')
      const after = await source.load()
      assert.equal(after.members.find((m) => m.id === m1.id)!.presence, 'working')
      assert.equal(after.members.find((m) => m.id === m2.id)!.presence, 'break')
      const upserts = c.changes.filter((x) => x.type === 'member_upsert') as Extract<Change, { type: 'member_upsert' }>[]
      assert.deepEqual(upserts.map((x) => x.member.id), [m1.id], 'member_upsert only for who changed')
    })

    it('only the ongoing meeting plus the 20 most recent ended ones are kept, newest last', async () => {
      const [m1] = ws.members
      const ids: string[] = []
      for (let i = 1; i <= 22; i++) {
        const m = await source.startMeeting({ title: `회의 ${i}`, attendeeIds: [m1.id] })
        ids.push(m.id)
        await source.endMeeting(m.id, { notes: '', outcomes: [] })
      }
      const ongoing = await source.startMeeting({ title: '진행 중', attendeeIds: [m1.id] })
      const list = (await source.load()).meetings
      assert.equal(list.length, 21)
      assert.deepEqual(list.map((m) => m.id), [...ids.slice(2), ongoing.id])
      assert.equal(list[list.length - 1].status, 'ongoing')
    })

    it('reset restores the seed', async () => {
      await source.createTask({ title: '지워질 작업', projectId: ws.projects[0].id })
      assert.ok(source.reset)
      const fresh = await source.reset!()
      assert.equal(fresh.tasks.length, 36)
      assert.equal(fresh.members.length, 7)
      assert.deepEqual(fresh.meetings, [])
      checkWorkspace(fresh, 'reset result')
      const again = await source.load()
      assert.equal(again.tasks.length, 36)
      assert.ok(!again.tasks.some((t) => t.title === '지워질 작업'))
    })

    it('returned entities are copies', async () => {
      const t = await source.createTask({ title: '복사본', projectId: ws.projects[0].id })
      const snapshot: Task = { ...t }
      t.title = 'MUTATED'
      const again = (await source.load()).tasks.find((x) => x.id === snapshot.id)!
      assert.equal(again.title, '복사본')
      const m: Member = (await source.load()).members[0]
      m.name = 'MUTATED'
      assert.notEqual((await source.load()).members[0].name, 'MUTATED')
    })
  })
}
