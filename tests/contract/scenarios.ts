// Shared contract scenarios: the same expectations run against the mock source and the API source.
// Not a *.test.ts file itself; mock.test.ts and api.test.ts call defineContractSuite().
import assert from 'node:assert/strict'
import { beforeEach, afterEach, describe, it } from 'node:test'
import { DataError, type DataErrorCode, type DataSource } from '../../src/data/DataSource'
import type { Activity, Change, Member, MemberInput, Task, TaskInput, Workspace } from '../../src/data/types'

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
}

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

    it('reset restores the seed', async () => {
      await source.createTask({ title: '지워질 작업', projectId: ws.projects[0].id })
      assert.ok(source.reset)
      const fresh = await source.reset!()
      assert.equal(fresh.tasks.length, 36)
      assert.equal(fresh.members.length, 7)
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
