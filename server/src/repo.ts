// All reads and validated mutations. Every mutation runs in ONE transaction; its Changes (entity
// changes + one activity change) are handed to `publish` only after the commit succeeded.
// Rules (validation, state transitions, Korean messages) live in src/data/rules and are shared with the
// mock source; this file adds persistence, seq numbers, the manager-touch window and the actor context.
import { DataError } from '../../src/data/DataSource.ts'
import { AVATAR_VARIANTS } from '../../src/data/meta.ts'
import { taskKey } from '../../src/data/selectors.ts'
import { DEMO_TASK_PREFIX, MAX_ACTIVITY } from '../../src/data/rules/constants.ts'
import { dropAgendaTask, dropAttendee, ongoingMeeting, planMeetingEnd, planMeetingStart, recentMeetings, MAX_ENDED_MEETINGS } from '../../src/data/rules/meetings.ts'
import {
  type ActivityDraft,
  MEETING_ENDED,
  MEETING_ONGOING,
  memberChangeActivity,
  memberJoinedMessage,
  memberLeftMessage,
  notFound,
  taskChangeActivity,
  taskCreatedMessage,
  taskDeletedMessage,
} from '../../src/data/rules/messages.ts'
import { applyMemberPatch } from '../../src/data/rules/members.ts'
import { buildSeed } from '../../src/data/rules/seed.ts'
import { applyTaskPatch, planMemberRemoval, topOrder } from '../../src/data/rules/tasks.ts'
import {
  type Lookup,
  checkMeetingEnd,
  checkMeetingStart,
  checkMemberInput,
  checkMemberPatch,
  checkReassign,
  checkTaskInput,
  checkTaskPatch,
  isObj,
} from '../../src/data/rules/validate.ts'
import type { Activity, Change, Id, Meeting, Member, Project, Task, Workspace } from '../../src/data/types.ts'
import { MAX_MEMBERS } from '../../src/office/layout.ts'
import type { Db } from './db.ts'

/** Who is asking. `actor` null = the manager (the user). */
export interface Ctx {
  actor: Member | null
  /** Bot only: change the data but leave no activity row (routine moves, presence). */
  quiet: boolean
}
/** A mutation's result plus the seq of its last change. */
export interface Done<T> {
  value: T
  seq: number
}

export const MANAGER: Ctx = { actor: null, quiet: false }

export interface RepoOptions {
  touchWindowMs: number
  now?: () => Date
  random?: () => number
}


export function createRepo(db: Db, publish: (entries: { seq: number; change: Change }[]) => void, opts: RepoOptions) {
  const now = opts.now ?? (() => new Date())
  const random = opts.random ?? Math.random
  const iso = () => now().toISOString()
  /** "task:<id>" / "member:<id>" -> ms when the manager last changed it. In memory only. */
  const touches = new Map<string, number>()

  // ---- reads --------------------------------------------------------------------

  const projects = () => db.all<Project>('projects')
  const members = () => db.all<Member>('members')
  const tasks = () => db.all<Task>('tasks')
  const meetings = () => db.all<Meeting>('meetings')
  const ongoing = () => ongoingMeeting(meetings())

  function workspace(): Workspace {
    return { projects: projects(), members: members(), tasks: tasks(), meetings: recentMeetings(meetings()), activity: db.all<Activity>('activity') }
  }

  const findMember = (id: Id) => db.get<Member>('members', id)
  const findTask = (id: Id) => db.get<Task>('tasks', id)

  const lookup: Lookup = {
    hasProject: (id) => db.get('projects', id) !== undefined,
    hasMember: (id) => findMember(id) !== undefined,
    hasTask: (id) => findTask(id) !== undefined,
    deskOwner: (deskId) => members().find((m) => m.deskId === deskId)?.id,
    memberCount: () => members().length,
  }

  // ---- helpers ------------------------------------------------------------------

  const currentSeq = () => Number(db.meta('seq') ?? '0')

  /**
   * Runs `fn` in one transaction. The seq numbers for its changes are reserved and persisted inside
   * that same transaction; broadcasting happens only after the commit and cannot fail the request.
   * `seq` = the seq of the last change (the current seq when nothing changed).
   */
  function mutate<T>(fn: (out: Change[]) => T): Done<T> {
    const out: Change[] = []
    const { value, base } = db.tx(() => {
      const value = fn(out)
      const base = currentSeq()
      if (out.length > 0) db.setMeta('seq', String(base + out.length))
      return { value, base }
    })
    const entries = out.map((change, i) => ({ seq: base + 1 + i, change }))
    try {
      publish(entries)
    } catch (e) {
      console.error('broadcast failed', e)
    }
    return { value, seq: base + out.length }
  }

  function uid(prefix: string, exists: (id: string) => boolean): string {
    for (;;) {
      const id = `${prefix}_${Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0')}`
      if (!exists(id)) return id
    }
  }

  const refOf = (t: Task) => taskKey(t, db.get<Project>('projects', t.projectId)?.key)
  const topOf = (assigneeId: Id | null) => topOrder(tasks(), assigneeId)
  const actorName = (ctx: Ctx) => ctx.actor?.name ?? null

  function nextNumber(): number {
    const n = Number(db.meta('nextNumber') ?? '1')
    db.setMeta('nextNumber', String(n + 1))
    return n
  }

  // Manager touches: the manager's own edits protect an entity from bot edits for a while.
  function touch(ctx: Ctx, kind: 'task' | 'member', id: Id) {
    if (ctx.actor === null) touches.set(`${kind}:${id}`, now().getTime())
  }
  function guard(ctx: Ctx, kind: 'task' | 'member', id: Id) {
    const at = touches.get(`${kind}:${id}`)
    if (ctx.actor !== null && at !== undefined && now().getTime() - at < opts.touchWindowMs) {
      throw new DataError('방금 직접 수정한 항목이라 잠시 후에 다시 시도해 주세요', 'conflict')
    }
  }

  function addActivity(out: Change[], ctx: Ctx, d: ActivityDraft) {
    if (ctx.quiet && ctx.actor) return
    const activity: Activity = {
      id: uid('a', (id) => db.get('activity', id) !== undefined),
      at: iso(),
      kind: d.kind,
      actorId: ctx.actor?.id ?? null,
      message: d.message,
    }
    if (d.taskId) activity.taskId = d.taskId
    if (d.memberId) activity.memberId = d.memberId
    db.put('activity', activity.id, activity)
    db.trim('activity', MAX_ACTIVITY)
    out.push({ type: 'activity', activity })
  }

  /** Writes a task and records it as an emitted change. */
  function saveTask(out: Change[], task: Task) {
    db.put('tasks', task.id, task)
    out.push({ type: 'task_upsert', task })
  }
  function saveMember(out: Change[], member: Member) {
    db.put('members', member.id, member)
    out.push({ type: 'member_upsert', member })
  }
  function saveMeeting(out: Change[], meeting: Meeting) {
    db.put('meetings', meeting.id, meeting)
    out.push({ type: 'meeting_upsert', meeting })
  }

  // ---- tasks --------------------------------------------------------------------

  function createTask(input: unknown, ctx: Ctx = MANAGER): Done<Task> {
    return mutate((out) => {
      const clean = checkTaskInput(input, lookup)
      const at = iso()
      const task: Task = {
        id: uid(ctx.actor ? DEMO_TASK_PREFIX : 't', (id) => findTask(id) !== undefined),
        number: nextNumber(),
        ...clean,
        order: topOf(clean.assigneeId),
        createdAt: at,
        updatedAt: at,
        completedAt: clean.status === 'done' ? at : null,
        onAgenda: false,
      }
      saveTask(out, task)
      touch(ctx, 'task', task.id)
      const assignee = task.assigneeId ? findMember(task.assigneeId) : undefined
      addActivity(out, ctx, {
        kind: 'task_created',
        message: taskCreatedMessage(refOf(task), task.assigneeId ? assignee?.name ?? '팀원' : null, actorName(ctx)),
        taskId: task.id,
      })
      return task
    })
  }

  function updateTask(id: Id, patch: unknown, ctx: Ctx = MANAGER): Done<Task> {
    return mutate((out) => {
      const task = findTask(id)
      if (!task) throw new DataError(notFound('task'), 'not_found')
      guard(ctx, 'task', id)
      if (isObj(patch)) touch(ctx, 'task', id)
      const { next, changed } = applyTaskPatch(task, checkTaskPatch(patch, lookup), { at: iso(), topOrder: topOf })
      if (changed.length === 0) return task // no-op: nothing is written or emitted

      saveTask(out, next)
      const assignee = next.assigneeId ? findMember(next.assigneeId) : undefined
      const draft = taskChangeActivity(next, changed, refOf(next), {
        actorId: ctx.actor?.id ?? null,
        actorName: actorName(ctx),
        assigneeName: assignee?.name ?? null,
      })
      if (draft) addActivity(out, ctx, draft)
      return next
    })
  }

  function deleteTask(id: Id, ctx: Ctx = MANAGER): Done<void> {
    return mutate((out) => {
      const task = findTask(id)
      if (!task) throw new DataError(notFound('task'), 'not_found')
      guard(ctx, 'task', id)
      touch(ctx, 'task', id)
      db.del('tasks', id)
      out.push({ type: 'task_delete', id })
      const meeting = dropAgendaTask(ongoing(), id)
      if (meeting) saveMeeting(out, meeting)
      addActivity(out, ctx, { kind: 'task_deleted', message: taskDeletedMessage(refOf(task), task.title, actorName(ctx)) })
    })
  }

  // ---- members ------------------------------------------------------------------

  function createMember(input: unknown, ctx: Ctx = MANAGER): Done<Member> {
    return mutate((out) => {
      const clean = checkMemberInput(input, lookup, MAX_MEMBERS)
      const member: Member = {
        id: uid('m', (id) => findMember(id) !== undefined),
        name: clean.name,
        role: clean.role,
        color: clean.color,
        capacity: clean.capacity,
        deskId: clean.deskId,
        presence: 'working',
        avatarVariant: clean.avatarVariant ?? Math.floor(random() * AVATAR_VARIANTS),
        joinedAt: iso(),
      }
      saveMember(out, member)
      touch(ctx, 'member', member.id)
      addActivity(out, ctx, { kind: 'member_joined', message: memberJoinedMessage(member.name), memberId: member.id })
      return member
    })
  }

  function updateMember(id: Id, patch: unknown, ctx: Ctx = MANAGER): Done<Member> {
    return mutate((out) => {
      const member = findMember(id)
      if (!member) throw new DataError(notFound('member'), 'not_found')
      guard(ctx, 'member', id)
      if (isObj(patch)) touch(ctx, 'member', id)
      const next = checkMemberPatch(patch, lookup, id)

      // The bot leaves people in an ongoing meeting alone.
      if (ctx.actor && next.presence !== undefined && next.presence !== member.presence && ongoing()?.attendeeIds.includes(id)) {
        throw new DataError('회의 중인 팀원이라 지금은 바꿀 수 없어요', 'conflict')
      }

      const { next: patched, changed, onlyPresence } = applyMemberPatch(member, next)
      if (changed.length === 0) return member
      saveMember(out, patched)
      addActivity(out, ctx, memberChangeActivity(id, patched.name, patched.presence, onlyPresence))
      return patched
    })
  }

  function deleteMember(id: Id, reassign: unknown, ctx: Ctx = MANAGER): Done<void> {
    return mutate((out) => {
      const member = findMember(id)
      if (!member) throw new DataError(notFound('member'), 'not_found')
      guard(ctx, 'member', id)
      const how = checkReassign(reassign, lookup, id)
      const target = how.mode === 'member' ? findMember(how.memberId) : undefined

      const plan = planMemberRemoval(id, tasks(), how, iso())
      for (const task of plan.tasks) {
        touch(ctx, 'task', task.id)
        saveTask(out, task)
      }
      db.del('members', id)
      out.push({ type: 'member_delete', id })
      const meeting = dropAttendee(ongoing(), id)
      if (meeting) saveMeeting(out, meeting)
      addActivity(out, ctx, { kind: 'member_left', message: memberLeftMessage(member.name, plan.movedOpen, target?.name ?? null), memberId: id })
    })
  }

  // ---- meetings -----------------------------------------------------------------

  function startMeeting(input: unknown, ctx: Ctx = MANAGER): Done<Meeting> {
    return mutate((out) => {
      const { title, attendeeIds } = checkMeetingStart(input, lookup)
      if (ongoing()) throw new DataError(MEETING_ONGOING, 'conflict')
      const plan = planMeetingStart({
        id: uid('mt', (id) => db.get('meetings', id) !== undefined),
        title,
        attendeeIds,
        tasks: tasks(),
        members: members(),
        at: iso(),
        actorName: actorName(ctx),
      })
      for (const member of plan.members) {
        touch(ctx, 'member', member.id)
        saveMember(out, member)
      }
      saveMeeting(out, plan.meeting)
      addActivity(out, ctx, { kind: 'meeting_started', message: plan.message })
      return plan.meeting
    })
  }

  function endMeeting(id: Id, input: unknown, ctx: Ctx = MANAGER): Done<Meeting> {
    return mutate((out) => {
      const meeting = db.get<Meeting>('meetings', id)
      if (!meeting) throw new DataError(notFound('meeting'), 'not_found')
      if (meeting.status !== 'ongoing') throw new DataError(MEETING_ENDED, 'conflict')
      const { notes, outcomes } = checkMeetingEnd(input, meeting.agendaTaskIds, lookup)
      const plan = planMeetingEnd({ meeting, notes, outcomes, tasks: tasks(), members: members(), at: iso(), actorName: actorName(ctx) })
      for (const task of plan.tasks) {
        touch(ctx, 'task', task.id)
        saveTask(out, task)
      }
      for (const member of plan.members) {
        touch(ctx, 'member', member.id)
        saveMember(out, member)
      }
      saveMeeting(out, plan.meeting)
      db.trim('meetings', MAX_ENDED_MEETINGS) // nothing is ongoing any more: keep only the recent ones
      addActivity(out, ctx, { kind: 'meeting_ended', message: plan.message })
      return plan.meeting
    })
  }

  // ---- seed / reset -------------------------------------------------------------

  function load(seed: ReturnType<typeof buildSeed>) {
    const ws = seed.workspace
    for (const t of ['projects', 'members', 'tasks', 'meetings', 'activity'] as const) db.clear(t)
    for (const p of ws.projects) db.put('projects', p.id, p)
    for (const m of ws.members) db.put('members', m.id, m)
    for (const t of ws.tasks) db.put('tasks', t.id, t)
    for (const m of ws.meetings) db.put('meetings', m.id, m)
    for (const a of ws.activity) db.put('activity', a.id, a)
    db.setMeta('nextNumber', String(seed.nextNumber))
  }

  /** Schema upgrade for databases written before meetings existed: tasks gain `onAgenda: false`. */
  function migrate() {
    db.tx(() => {
      for (const t of db.all<Task>('tasks')) {
        if (typeof t.onAgenda !== 'boolean') db.put('tasks', t.id, { ...t, onAgenda: false })
      }
    })
  }

  /** Boot: seeds an empty database (same office as the mock source), otherwise upgrades an old one. */
  function seedIfEmpty(): boolean {
    if (db.meta('nextNumber') !== undefined) {
      migrate()
      return false
    }
    db.tx(() => load(buildSeed(now())))
    return true
  }

  /** Reseeds with fresh relative dates and broadcasts a snapshot. */
  function reset(): Done<Workspace> {
    return mutate((out) => {
      load(buildSeed(now()))
      touches.clear()
      const ws = workspace()
      out.push({ type: 'snapshot', workspace: ws })
      return ws
    })
  }

  // ---- demo flag (persisted so a server restart keeps it) ----------------------------

  const demoOn = () => db.meta('demo') === '1'
  /** Boot-time override from ServerOptions; nobody is connected yet, so nothing is broadcast. */
  const storeDemo = (on: boolean) => db.setMeta('demo', on ? '1' : '0')
  /** PUT /api/demo: persists the flag and broadcasts a `demo` change. */
  function setDemo(on: boolean): Done<boolean> {
    return mutate((out) => {
      storeDemo(on)
      out.push({ type: 'demo', on })
      return on
    })
  }

  return {
    workspace,
    demoOn,
    storeDemo,
    setDemo,
    currentSeq,
    findMember,
    seedIfEmpty,
    reset,
    createTask,
    updateTask,
    deleteTask,
    createMember,
    updateMember,
    deleteMember,
    startMeeting,
    endMeeting,
  }
}

export type Repo = ReturnType<typeof createRepo>
