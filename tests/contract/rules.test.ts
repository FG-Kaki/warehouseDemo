// Pure checks of the shared rules module (src/data/rules): no source, no storage, no timers.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DataError } from '../../src/data/DataSource'
import { planDemoAction } from '../../src/data/rules/demo'
import { planMeetingEnd, planMeetingStart } from '../../src/data/rules/meetings'
import { buildSeed } from '../../src/data/rules/seed'
import { applyTaskPatch, planMemberRemoval, topOrder } from '../../src/data/rules/tasks'
import { checkMeetingEnd, checkMeetingStart, type Lookup } from '../../src/data/rules/validate'

const seed = () => buildSeed(new Date('2030-01-07T09:00:00Z')).workspace
const lookupOf = (ws: ReturnType<typeof seed>): Lookup => ({
  hasProject: (id) => ws.projects.some((p) => p.id === id),
  hasMember: (id) => ws.members.some((m) => m.id === id),
  hasTask: (id) => ws.tasks.some((t) => t.id === id),
  deskOwner: (d) => ws.members.find((m) => m.deskId === d)?.id,
  memberCount: () => ws.members.length,
})
const seededRandom = (seedValue: number) => {
  let a = seedValue
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0
    return a / 4294967296
  }
}

describe('rules', () => {
  it('applyTaskPatch: done clears the agenda, a done task cannot join it, no-ops report nothing', () => {
    const ws = seed()
    const onAgenda = ws.tasks.find((t) => t.onAgenda)!
    const at = '2030-01-07T10:00:00.000Z'
    const ctx = { at, topOrder: (id: string | null) => topOrder(ws.tasks, id) }
    const done = applyTaskPatch(onAgenda, { status: 'done' }, ctx)
    assert.equal(done.next.onAgenda, false)
    assert.equal(done.next.completedAt, at)
    assert.equal(done.next.updatedAt, at)
    assert.throws(() => applyTaskPatch(done.next, { onAgenda: true }, ctx), (e) => e instanceof DataError && e.message === '완료된 작업은 안건으로 올릴 수 없어요')
    const same = applyTaskPatch(onAgenda, { title: onAgenda.title }, ctx)
    assert.deepEqual(same.changed, [])
    assert.equal(same.next.updatedAt, onAgenda.updatedAt)
    const moved = applyTaskPatch(onAgenda, { assigneeId: ws.members[0].id }, ctx)
    assert.ok(moved.next.order > Math.max(...ws.tasks.filter((t) => t.assigneeId === ws.members[0].id).map((t) => t.order)))
  })

  it('planMemberRemoval: open tasks move, done tasks only lose the assignee', () => {
    const ws = seed()
    const victim = ws.members[1]
    const plan = planMemberRemoval(victim.id, ws.tasks, { mode: 'backlog' }, '2030-01-07T10:00:00.000Z')
    const theirs = ws.tasks.filter((t) => t.assigneeId === victim.id)
    assert.equal(plan.tasks.length, theirs.length)
    assert.equal(plan.movedOpen, theirs.filter((t) => t.status !== 'done').length)
    assert.ok(plan.tasks.every((t) => t.assigneeId === null && t.status !== 'in_progress' && t.status !== 'review'))
    assert.ok(ws.tasks.some((t) => t.id === theirs[0].id && t.assigneeId === victim.id), 'the input is not mutated')
  })

  it('planMeetingStart / planMeetingEnd follow the documented rules without touching their input', () => {
    const ws = seed()
    const l = lookupOf(ws)
    const { title, attendeeIds } = checkMeetingStart({ title: '  스프린트 계획 ', attendeeIds: [ws.members[0].id, ws.members[2].id] }, l)
    const start = planMeetingStart({ id: 'mt_x', title, attendeeIds, tasks: ws.tasks, members: ws.members, at: '2030-01-07T10:00:00.000Z' })
    assert.equal(start.message, '스프린트 계획을 시작했어요 · 참석 2명 · 안건 2건')
    assert.deepEqual(start.meeting.agendaTaskIds.map((id) => ws.tasks.find((t) => t.id === id)!.number), [35, 20])
    assert.ok(start.members.every((m) => m.presence === 'meeting'))
    assert.equal(ws.members[0].presence, 'working', 'input untouched')

    const agenda = start.meeting.agendaTaskIds
    const clean = checkMeetingEnd(
      { notes: '메모', outcomes: [{ taskId: agenda[0], action: 'backlog' }, { taskId: agenda[1], action: 'keep' }, { taskId: 'gone', action: 'keep' }] },
      agenda,
      l,
    )
    assert.equal(clean.outcomes.length, 2, 'an outcome for a task that no longer exists is dropped')
    const members = ws.members.map((m) => start.members.find((x) => x.id === m.id) ?? m)
    const end = planMeetingEnd({ meeting: start.meeting, notes: clean.notes, outcomes: clean.outcomes, tasks: ws.tasks, members, at: '2030-01-07T11:00:00.000Z' })
    assert.equal(end.decisions, 1)
    assert.equal(end.message, '스프린트 계획이 끝났어요 · 결정 1건')
    assert.equal(end.tasks.length, 1, 'keep changes nothing')
    assert.equal(end.tasks[0].id, agenda[0])
    assert.equal(end.tasks[0].onAgenda, false)
    assert.deepEqual(end.members.map((m) => m.id).sort(), [...attendeeIds].sort())
    assert.ok(end.members.every((m) => m.presence === 'working'))
    assert.equal(end.meeting.status, 'ended')
  })

  it('planDemoAction never touches agenda tasks or a running meeting\'s attendees', () => {
    const ws = seed()
    const attendees = ws.members.slice(0, 3).map((m) => m.id)
    const { meeting, members } = planMeetingStart({ id: 'mt_x', title: '회의', attendeeIds: attendees, tasks: ws.tasks, members: ws.members, at: '2030-01-07T10:00:00.000Z' })
    const snapshot = { projects: ws.projects, tasks: ws.tasks, members: ws.members.map((m) => members.find((x) => x.id === m.id) ?? m), meetings: [meeting] }
    const agenda = new Set(ws.tasks.filter((t) => t.onAgenda).map((t) => t.id))
    for (let i = 0; i < 400; i++) {
      const action = planDemoAction({ ws: snapshot, now: new Date('2030-01-07T10:00:00Z'), random: seededRandom(i + 1) })
      if (!action) continue
      if ('taskId' in action) assert.ok(!agenda.has(action.taskId), `${action.name} left the agenda alone`)
      assert.notEqual(action.name, 'meeting', 'no informal meeting during a real one')
      if ('memberId' in action) assert.ok(!attendees.includes(action.memberId), 'attendees are not sent away')
    }
  })
})
