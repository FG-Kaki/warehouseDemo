// All reads and validated mutations. Every mutation runs in ONE transaction; its Changes (entity
// changes + one activity change) are handed to `publish` only after the commit succeeded.
import { DataError } from '../../src/data/DataSource.ts'
import { AVATAR_VARIANTS, PRIORITY_META } from '../../src/data/meta.ts'
import { taskKey } from '../../src/data/selectors.ts'
import { buildSeed } from '../../src/data/mock/seed.ts'
import { eul, iGa, refObject, STATUS_TO, taskObject } from '../../src/data/mock/text.ts'
import type {
  Activity,
  ActivityKind,
  Change,
  Id,
  Meeting,
  Member,
  MemberInput,
  MemberPatch,
  MeetingStart,
  Presence,
  Project,
  Reassign,
  Task,
  TaskInput,
  TaskPatch,
  Workspace,
} from '../../src/data/types.ts'
import { MAX_MEMBERS, OFFICE } from '../../src/office/layout.ts'
import type { Db } from './db.ts'
import {
  type Lookup,
  checkAgendaFlag,
  checkAssignee,
  checkAttendees,
  checkCapacity,
  checkColor,
  checkDesk,
  checkDescription,
  checkDueDate,
  checkEstimate,
  checkMeetingTitle,
  checkName,
  checkNotes,
  checkOrder,
  checkOutcomes,
  checkPresence,
  checkPriority,
  checkProject,
  checkRole,
  checkStatus,
  checkTitle,
  checkVariant,
  isObj,
} from './validate.ts'

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

const MAX_ACTIVITY = 100
const MAX_ENDED_MEETINGS = 20
/** Id prefix of tasks created through bot requests, so the bot can prune only its own done tasks. */
export const BOT_TASK_PREFIX = 'td'

const PRESENCE_MESSAGE: Record<Presence, string> = {
  working: '님이 작업을 시작했어요',
  meeting: '님이 회의에 들어갔어요',
  break: '님이 휴식 중이에요',
  away: '님이 자리를 비웠어요',
}

const CONTENT_KEYS: (keyof Task)[] = ['title', 'description', 'priority', 'estimate', 'projectId', 'dueDate']

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
  const ongoingMeeting = () => meetings().find((m) => m.status === 'ongoing')

  /** The ongoing meeting plus the 20 most recent ended ones, in insertion order (newest last). */
  function recentMeetings(): Meeting[] {
    const all = meetings()
    const keepEnded = new Set(all.filter((m) => m.status === 'ended').slice(-MAX_ENDED_MEETINGS).map((m) => m.id))
    return all.filter((m) => m.status === 'ongoing' || keepEnded.has(m.id))
  }

  function workspace(): Workspace {
    return { projects: projects(), members: members(), tasks: tasks(), meetings: recentMeetings(), activity: db.all<Activity>('activity') }
  }

  const findMember = (id: Id) => db.get<Member>('members', id)
  const findTask = (id: Id) => db.get<Task>('tasks', id)

  const lookup: Lookup = {
    hasProject: (id) => db.get('projects', id) !== undefined,
    hasMember: (id) => findMember(id) !== undefined,
    hasTask: (id) => findTask(id) !== undefined,
    deskOwner: (deskId) => members().find((m) => m.deskId === deskId)?.id,
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
  const nameOf = (id: Id | null | undefined) => (id ? findMember(id)?.name ?? '팀원' : '매니저')

  function topOrder(assigneeId: Id | null): number {
    let max = 0
    for (const t of tasks()) if (t.assigneeId === assigneeId && t.order > max) max = t.order
    return max + 1
  }

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

  /** Message prefix for bot actions ("김하늘 님이 "), empty for the manager. */
  const by = (ctx: Ctx) => (ctx.actor ? `${ctx.actor.name} 님이 ` : '')

  function addActivity(out: Change[], ctx: Ctx, d: { kind: ActivityKind; message: string; taskId?: Id; memberId?: Id }) {
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

  // ---- tasks --------------------------------------------------------------------

  function createTask(input: unknown, ctx: Ctx = MANAGER): Done<Task> {
    return mutate((out) => {
      if (!isObj(input)) throw new DataError('제목을 입력해 주세요')
      const i = input as Partial<TaskInput>
      const title = checkTitle(i.title)
      const projectId = checkProject(i.projectId, lookup)
      const assigneeId = i.assigneeId === undefined ? null : checkAssignee(i.assigneeId, lookup)
      const description = i.description === undefined ? '' : checkDescription(i.description)
      const status = i.status === undefined ? 'todo' : checkStatus(i.status)
      const priority = i.priority === undefined ? 'medium' : checkPriority(i.priority)
      const estimate = i.estimate === undefined ? 3 : checkEstimate(i.estimate)
      const dueDate = i.dueDate === undefined ? null : checkDueDate(i.dueDate)

      const at = iso()
      const task: Task = {
        id: uid(ctx.actor ? BOT_TASK_PREFIX : 't', (id) => findTask(id) !== undefined),
        number: nextNumber(),
        title,
        description,
        status,
        priority,
        estimate,
        projectId,
        assigneeId,
        dueDate,
        order: topOrder(assigneeId),
        createdAt: at,
        updatedAt: at,
        completedAt: status === 'done' ? at : null,
        onAgenda: false,
      }
      db.put('tasks', task.id, task)
      touch(ctx, 'task', task.id)
      out.push({ type: 'task_upsert', task })

      const ref = refObject(refOf(task))
      addActivity(out, ctx, {
        kind: 'task_created',
        message: assigneeId ? `${by(ctx)}새 작업 ${ref} 만들어 ${nameOf(assigneeId)} 님에게 배정했어요` : `${by(ctx)}새 작업 ${ref} 만들었어요`,
        taskId: task.id,
      })
      return task
    })
  }

  function updateTask(id: Id, patch: unknown, ctx: Ctx = MANAGER): Done<Task> {
    return mutate((out) => {
      const task = findTask(id)
      if (!task) throw new DataError('작업을 찾을 수 없어요', 'not_found')
      guard(ctx, 'task', id)
      if (!isObj(patch)) throw new DataError('수정할 내용이 올바르지 않아요')
      const p = patch as TaskPatch

      touch(ctx, 'task', id)
      const next: Partial<Task> = {}
      if (p.title !== undefined) next.title = checkTitle(p.title)
      if (p.description !== undefined) next.description = checkDescription(p.description)
      if (p.status !== undefined) next.status = checkStatus(p.status)
      if (p.priority !== undefined) next.priority = checkPriority(p.priority)
      if (p.estimate !== undefined) next.estimate = checkEstimate(p.estimate)
      if (p.projectId !== undefined) next.projectId = checkProject(p.projectId, lookup)
      if (p.assigneeId !== undefined) next.assigneeId = checkAssignee(p.assigneeId, lookup)
      if (p.dueDate !== undefined) next.dueDate = checkDueDate(p.dueDate)
      if (p.order !== undefined) next.order = checkOrder(p.order)
      if (p.onAgenda !== undefined) next.onAgenda = checkAgendaFlag(p.onAgenda)

      // Done tasks are never on the agenda: completing one clears the flag, putting one on is refused.
      if ((next.status ?? task.status) === 'done') {
        if (next.onAgenda === true) throw new DataError('완료된 작업은 안건으로 올릴 수 없어요')
        if (task.onAgenda) next.onAgenda = false
      }

      const at = iso()
      if (next.assigneeId !== undefined && next.assigneeId !== task.assigneeId && next.order === undefined) {
        next.order = topOrder(next.assigneeId)
      }
      if (next.status !== undefined && next.status !== task.status) {
        next.completedAt = next.status === 'done' ? at : null
      }

      const changed = (Object.keys(next) as (keyof Task)[]).filter((k) => next[k] !== task[k])
      if (changed.length === 0) return task // no-op: nothing is written or emitted

      Object.assign(task, next, { updatedAt: at })
      db.put('tasks', id, task)
      out.push({ type: 'task_upsert', task })

      const ref = refOf(task)
      const subject = taskObject(ref, task.title)
      const actor = ctx.actor
      if (changed.includes('assigneeId')) {
        let message: string
        if (!task.assigneeId) message = `${by(ctx)}${subject} 백로그로 돌렸어요`
        else if (actor && actor.id === task.assigneeId) message = `${by(ctx)}${subject} 맡았어요`
        else message = `${by(ctx)}${subject} ${nameOf(task.assigneeId)} 님에게 배정했어요`
        addActivity(out, ctx, { kind: 'task_assigned', message, taskId: id, ...(task.assigneeId ? { memberId: task.assigneeId } : {}) })
      } else if (changed.includes('status')) {
        let message: string
        if (!actor) message = task.status === 'done' ? `${subject} 완료 처리했어요` : `${subject} ${STATUS_TO[task.status]} 옮겼어요`
        else if (task.status === 'done') {
          const own = task.assigneeId === null || task.assigneeId === actor.id
          message = own ? `${by(ctx)}${refObject(ref)} 완료했어요` : `${by(ctx)}${refObject(ref)} 검토하고 완료 처리했어요`
        } else message = `${by(ctx)}${refObject(ref)} ${STATUS_TO[task.status]} 옮겼어요`
        addActivity(out, ctx, { kind: 'task_status', message, taskId: id })
      } else if (changed.some((k) => CONTENT_KEYS.includes(k))) {
        addActivity(out, ctx, { kind: 'task_updated', message: `${by(ctx)}${subject} 수정했어요`, taskId: id })
      }
      return task
    })
  }

  function deleteTask(id: Id, ctx: Ctx = MANAGER): Done<void> {
    return mutate((out) => {
      const task = findTask(id)
      if (!task) throw new DataError('작업을 찾을 수 없어요', 'not_found')
      guard(ctx, 'task', id)
      touch(ctx, 'task', id)
      db.del('tasks', id)
      out.push({ type: 'task_delete', id })
      const meeting = ongoingMeeting()
      if (meeting?.agendaTaskIds.includes(id)) {
        meeting.agendaTaskIds = meeting.agendaTaskIds.filter((x) => x !== id)
        db.put('meetings', meeting.id, meeting)
        out.push({ type: 'meeting_upsert', meeting })
      }
      addActivity(out, ctx, { kind: 'task_deleted', message: `${by(ctx)}${taskObject(refOf(task), task.title)} 삭제했어요` })
    })
  }

  // ---- members ------------------------------------------------------------------

  function createMember(input: unknown, ctx: Ctx = MANAGER): Done<Member> {
    return mutate((out) => {
      if (!isObj(input)) throw new DataError('이름을 입력해 주세요')
      const i = input as Partial<MemberInput>
      const name = checkName(i.name)
      const role = checkRole(i.role)
      const color = checkColor(i.color)
      const capacity = checkCapacity(i.capacity)
      const avatarVariant = i.avatarVariant === undefined ? Math.floor(random() * AVATAR_VARIANTS) : checkVariant(i.avatarVariant)
      const all = members()
      if (all.length >= MAX_MEMBERS) throw new DataError('자리가 모두 찼어요', 'conflict')
      let deskId: string
      if (i.deskId !== undefined) {
        deskId = checkDesk(i.deskId, lookup)
      } else {
        const used = new Set(all.map((m) => m.deskId))
        const free = OFFICE.desks.find((d) => !used.has(d.id))
        if (!free) throw new DataError('자리가 모두 찼어요', 'conflict')
        deskId = free.id
      }
      const member: Member = {
        id: uid('m', (id) => findMember(id) !== undefined),
        name,
        role,
        color,
        capacity,
        deskId,
        presence: 'working',
        avatarVariant,
        joinedAt: iso(),
      }
      db.put('members', member.id, member)
      touch(ctx, 'member', member.id)
      out.push({ type: 'member_upsert', member })
      addActivity(out, ctx, { kind: 'member_joined', message: `${name} 님이 합류했어요`, memberId: member.id })
      return member
    })
  }

  function updateMember(id: Id, patch: unknown, ctx: Ctx = MANAGER): Done<Member> {
    return mutate((out) => {
      const member = findMember(id)
      if (!member) throw new DataError('팀원을 찾을 수 없어요', 'not_found')
      guard(ctx, 'member', id)
      if (!isObj(patch)) throw new DataError('수정할 내용이 올바르지 않아요')
      const p = patch as MemberPatch

      touch(ctx, 'member', id)
      const next: Partial<Member> = {}
      if (p.name !== undefined) next.name = checkName(p.name)
      if (p.role !== undefined) next.role = checkRole(p.role)
      if (p.color !== undefined) next.color = checkColor(p.color)
      if (p.capacity !== undefined) next.capacity = checkCapacity(p.capacity)
      if (p.deskId !== undefined) next.deskId = checkDesk(p.deskId, lookup, id)
      if (p.presence !== undefined) next.presence = checkPresence(p.presence)

      // The bot leaves people in an ongoing meeting alone.
      if (ctx.actor && next.presence !== undefined && next.presence !== member.presence && ongoingMeeting()?.attendeeIds.includes(id)) {
        throw new DataError('회의 중인 팀원이라 지금은 바꿀 수 없어요', 'conflict')
      }

      const changed = (Object.keys(next) as (keyof Member)[]).filter((k) => next[k] !== member[k])
      if (changed.length === 0) return member
      Object.assign(member, next)
      db.put('members', id, member)
      out.push({ type: 'member_upsert', member })

      const onlyPresence = changed.length === 1 && changed[0] === 'presence'
      addActivity(out, ctx, {
        kind: onlyPresence ? 'presence' : 'member_updated',
        message: onlyPresence ? `${member.name} ${PRESENCE_MESSAGE[member.presence]}` : `${member.name} 님의 정보를 수정했어요`,
        memberId: id,
      })
      return member
    })
  }

  function deleteMember(id: Id, reassign: Reassign | null, ctx: Ctx = MANAGER): Done<void> {
    return mutate((out) => {
      const member = findMember(id)
      if (!member) throw new DataError('팀원을 찾을 수 없어요', 'not_found')
      guard(ctx, 'member', id)
      if (!reassign || (reassign.mode !== 'backlog' && reassign.mode !== 'member')) throw new DataError('작업 처리 방법을 선택해 주세요')
      let target: Member | undefined
      if (reassign.mode === 'member') {
        target = findMember(reassign.memberId)
        if (!target) throw new DataError('작업을 넘겨받을 팀원을 찾을 수 없어요')
        if (target.id === id) throw new DataError('같은 팀원에게는 넘길 수 없어요')
      }

      const at = iso()
      let movedOpen = 0
      const theirs = tasks()
        .filter((t) => t.assigneeId === id)
        .sort((a, b) => a.order - b.order)
      for (const task of theirs) {
        if (task.status === 'done') {
          task.assigneeId = null
        } else if (target) {
          task.assigneeId = target.id
          task.order = topOrder(target.id)
          movedOpen++
        } else {
          task.assigneeId = null
          task.order = topOrder(null)
          if (task.status === 'in_progress' || task.status === 'review') task.status = 'todo'
          movedOpen++
        }
        task.updatedAt = at
        db.put('tasks', task.id, task) // written before the next topOrder() so stacks stay consistent
        touch(ctx, 'task', task.id)
        out.push({ type: 'task_upsert', task })
      }
      db.del('members', id)
      out.push({ type: 'member_delete', id })
      const meeting = ongoingMeeting()
      if (meeting?.attendeeIds.includes(id)) {
        meeting.attendeeIds = meeting.attendeeIds.filter((x) => x !== id)
        db.put('meetings', meeting.id, meeting)
        out.push({ type: 'meeting_upsert', meeting })
      }

      let message = `${member.name} 님이 팀을 떠났어요`
      if (movedOpen > 0) {
        message = target
          ? `${member.name} 님이 팀을 떠나 작업 ${movedOpen}개를 ${target.name} 님에게 넘겼어요`
          : `${member.name} 님이 팀을 떠나 작업 ${movedOpen}개를 백로그로 옮겼어요`
      }
      addActivity(out, ctx, { kind: 'member_left', message, memberId: id })
    })
  }

  // ---- meetings -----------------------------------------------------------------

  function startMeeting(input: unknown, ctx: Ctx = MANAGER): Done<Meeting> {
    return mutate((out) => {
      if (!isObj(input)) throw new DataError('회의 이름을 입력해 주세요')
      const i = input as Partial<MeetingStart>
      const title = checkMeetingTitle(i.title)
      const attendeeIds = checkAttendees(i.attendeeIds, lookup)
      if (ongoingMeeting()) throw new DataError('이미 회의가 진행 중이에요', 'conflict')

      const weight = (t: Task) => PRIORITY_META[t.priority].weight
      const agendaTaskIds = tasks()
        .filter((t) => t.onAgenda && t.status !== 'done')
        .sort((a, b) => weight(b) - weight(a) || a.number - b.number)
        .map((t) => t.id)

      for (const id of attendeeIds) {
        const member = findMember(id)!
        member.presence = 'meeting'
        db.put('members', id, member)
        touch(ctx, 'member', id)
        out.push({ type: 'member_upsert', member })
      }
      const meeting: Meeting = {
        id: uid('mt', (id) => db.get('meetings', id) !== undefined),
        title,
        attendeeIds,
        agendaTaskIds,
        status: 'ongoing',
        startedAt: iso(),
        endedAt: null,
        notes: '',
        outcomes: [],
      }
      db.put('meetings', meeting.id, meeting)
      out.push({ type: 'meeting_upsert', meeting })
      addActivity(out, ctx, {
        kind: 'meeting_started',
        message: `${by(ctx)}${title}${eul(title)} 시작했어요 · 참석 ${attendeeIds.length}명 · 안건 ${agendaTaskIds.length}건`,
      })
      return meeting
    })
  }

  function endMeeting(id: Id, input: unknown, ctx: Ctx = MANAGER): Done<Meeting> {
    return mutate((out) => {
      const meeting = db.get<Meeting>('meetings', id)
      if (!meeting) throw new DataError('회의를 찾을 수 없어요', 'not_found')
      if (meeting.status !== 'ongoing') throw new DataError('이미 끝난 회의예요', 'conflict')
      if (!isObj(input)) throw new DataError('요청 내용이 올바르지 않아요')
      const notes = checkNotes(input.notes)
      const outcomes = checkOutcomes(input.outcomes, meeting.agendaTaskIds, lookup)

      // Apply the decisions. Tasks deleted meanwhile are no longer on the agenda (see deleteTask).
      const at = iso()
      const decided = new Map(outcomes.map((o) => [o.taskId, o]))
      for (const taskId of meeting.agendaTaskIds) {
        const task = findTask(taskId)
        if (!task) continue
        const o = decided.get(taskId) ?? { taskId, action: 'keep' as const }
        const before = JSON.stringify(task)
        if (o.action === 'assign') {
          if (task.assigneeId !== o.memberId) {
            task.assigneeId = o.memberId
            task.order = topOrder(o.memberId)
          }
        } else if (o.action === 'status') {
          if (task.status !== o.status) {
            task.status = o.status
            task.completedAt = o.status === 'done' ? at : null
          }
        } else if (o.action === 'backlog') {
          if (task.assigneeId !== null) {
            task.assigneeId = null
            task.order = topOrder(null)
          }
          if (task.status === 'in_progress' || task.status === 'review') task.status = 'todo'
        }
        if (o.action !== 'keep') task.onAgenda = false
        if (JSON.stringify(task) === before) continue
        task.updatedAt = at
        db.put('tasks', task.id, task) // written before the next topOrder() so stacks stay consistent
        touch(ctx, 'task', task.id)
        out.push({ type: 'task_upsert', task })
      }

      for (const memberId of meeting.attendeeIds) {
        const member = findMember(memberId)
        if (!member || member.presence !== 'meeting') continue
        member.presence = 'working'
        db.put('members', memberId, member)
        touch(ctx, 'member', memberId)
        out.push({ type: 'member_upsert', member })
      }

      Object.assign(meeting, { status: 'ended', endedAt: at, notes, outcomes })
      db.put('meetings', id, meeting)
      db.trim('meetings', MAX_ENDED_MEETINGS) // nothing is ongoing any more: keep only the recent ones
      out.push({ type: 'meeting_upsert', meeting })
      const decisions = outcomes.filter((o) => o.action !== 'keep').length
      addActivity(out, ctx, { kind: 'meeting_ended', message: `${by(ctx)}${meeting.title}${iGa(meeting.title)} 끝났어요 · 결정 ${decisions}건` })
      return meeting
    })
  }

  // ---- seed / reset -------------------------------------------------------------

  function load(seed: ReturnType<typeof buildSeed>) {
    const ws = seed.workspace
    for (const t of ['projects', 'members', 'tasks', 'meetings', 'activity'] as const) db.clear(t)
    for (const p of ws.projects) db.put('projects', p.id, p)
    for (const m of ws.members) db.put('members', m.id, m)
    for (const t of ws.tasks) db.put('tasks', t.id, { ...t, onAgenda: t.onAgenda === true })
    for (const m of ws.meetings ?? []) db.put('meetings', m.id, m)
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
