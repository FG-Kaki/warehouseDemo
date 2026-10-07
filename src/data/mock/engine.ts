// The "backend" of the mock source: validated, synchronous mutations over an in-memory workspace.
// index.ts wraps these with latency; demo.ts drives them to simulate teammates. Every mutation
// goes through commit(): activity, persistence and change notification all happen in one place.
import { DataError } from '../DataSource'
import { AVATAR_VARIANTS, PRESENCE_META } from '../meta'
import { taskKey } from '../selectors'
import type {
  Activity,
  ActivityKind,
  Change,
  Id,
  Meeting,
  MeetingEnd,
  MeetingStart,
  Member,
  MemberInput,
  MemberPatch,
  Presence,
  Reassign,
  Task,
  TaskInput,
  TaskPatch,
  Workspace,
} from '../types'
import { MAX_MEMBERS, OFFICE } from '../../office/layout'
import { DEMO_TASK_PREFIX, MAX_ACTIVITY, TOUCH_WINDOW_MS } from '../rules/constants'
import { applyMemberPatch } from '../rules/members'
import { dropAgendaTask, dropAttendee, ongoingMeeting, planMeetingEnd, planMeetingStart } from '../rules/meetings'
import {
  MEETING_ENDED,
  MEETING_ONGOING,
  memberChangeActivity,
  memberJoinedMessage,
  memberLeftMessage,
  notFound,
  taskChangeActivity,
  taskCreatedMessage,
  taskDeletedMessage,
} from '../rules/messages'
import { buildSeed } from '../rules/seed'
import { applyTaskPatch, planMemberRemoval, topOrder as stackTop } from '../rules/tasks'
import { checkMeetingEnd, checkMeetingStart, checkMemberInput, checkMemberPatch, checkReassign, checkTaskInput, checkTaskPatch, isObj, type Lookup } from '../rules/validate'
import { META_KEY, STORAGE_KEY, backupCorrupt, loadPersisted, normalizeMeetings, parsePersisted, type Persisted, type StorageLike } from './storage'

export interface EngineOptions {
  storage: StorageLike
  random: () => number
  now: () => Date
}

/** Extra control for internal callers (demo mode). The DataSource methods never pass these. */
export interface MutationMeta {
  /** Who did it: a member id, or null/undefined for the manager. */
  actorId?: Id | null
  /** Replaces the generated activity message; null suppresses the activity entirely. */
  message?: string | null
  kind?: ActivityKind
  /** Set by demo mode only: a simulated teammate / the company, not the manager. */
  demo?: boolean
}

export interface ReturnPlan {
  /** ms since epoch when the member goes back to work. */
  at: number
  presence: Presence
}

export interface MockEngine {
  /** Live internal state. Read-only for the demo; never hand it out. */
  readonly ws: Workspace
  readonly nextNumber: number
  snapshot(): Workspace
  createTask(input: TaskInput, meta?: MutationMeta): Task
  updateTask(id: Id, patch: TaskPatch, meta?: MutationMeta): Task
  deleteTask(id: Id, opts?: { silent?: boolean; demo?: boolean }): void
  createMember(input: MemberInput): Member
  updateMember(id: Id, patch: MemberPatch): Member
  deleteMember(id: Id, reassign: Reassign): void
  startMeeting(input: MeetingStart): Meeting
  endMeeting(id: Id, result: MeetingEnd): Meeting
  /** Demo helper: change presence of several members in one go, with an optional activity. */
  setPresence(ids: Id[], presence: Presence, activity?: { message: string; memberId?: Id } | null): void
  reset(): Workspace
  subscribe(listener: (change: Change) => void): () => void
  /** Writes pending changes to storage right now. */
  flush(): void
  /** Called after reset() so the demo can drop its timers. */
  onReset(cb: () => void): void
  /** Called after another tab's data (workspace or planned returns) was merged in. */
  onAdopt(cb: () => void): void
  /** Planned returns of members the demo sent away (shared between tabs). */
  getPlans(): ReadonlyMap<Id, ReturnPlan>
  /** Sets (or with null clears) a member's planned return; persisted at once. */
  setPlan(id: Id, plan: ReturnPlan | null): void
  /** True when the manager (not demo mode) changed this task / member within `windowMs`. */
  touchedRecently(kind: 'task' | 'member', id: Id, windowMs?: number): boolean
}

/** Demo mode leaves things the manager touched this recently alone. */
export const MANAGER_TOUCH_WINDOW_MS = TOUCH_WINDOW_MS
/** Id prefix of tasks created by demo mode; only those are ever pruned automatically. */
export { DEMO_TASK_PREFIX }

const PERSIST_DEBOUNCE_MS = 200

const clone = <T>(v: T): T => structuredClone(v)

export function createEngine(opts: EngineOptions): MockEngine {
  const { storage, random, now } = opts
  let state: Persisted | null = null
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let idFallback = 0
  const listeners = new Set<(c: Change) => void>()
  const resetHooks: (() => void)[] = []
  const adoptHooks: (() => void)[] = []
  /** When the manager last changed a task / member (keys "task:<id>", "member:<id>"). Shared via the meta key. */
  const touches = new Map<string, number>()
  /** Planned returns of members the demo sent away. Shared via the meta key so every tab honours them. */
  const plans = new Map<Id, ReturnPlan>()
  // Local changes not yet written to storage. They win over incoming data when another tab's write is merged.
  const dirtyTasks = new Set<Id>()
  const deletedTasks = new Set<Id>()
  const dirtyMembers = new Set<Id>()
  const deletedMembers = new Set<Id>()
  const dirtyActivity = new Set<Id>()
  const dirtyMeetings = new Set<Id>()
  const planOps = new Map<Id, ReturnPlan | null>()
  /** Last workspace / meta strings we wrote or adopted; a different stored string means another tab wrote. */
  let lastRaw: string | null = null
  let lastMetaRaw: string | null = null

  const safeGet = (key: string): string | null => {
    try {
      return storage.getItem(key)
    } catch {
      return null
    }
  }
  const safeSet = (key: string, value: string): boolean => {
    try {
      storage.setItem(key, value)
      return true
    } catch {
      return false
    }
  }

  // ---- meta: manager touches + planned returns ---------------------------------

  function pruneTouches(t: number) {
    for (const [k, at] of touches) if (t - at > MANAGER_TOUCH_WINDOW_MS) touches.delete(k)
  }

  /** Folds the stored meta into memory (touches: newest wins; plans: stored + our unsaved ops). Returns true if plans changed. */
  function mergeMeta(raw: string | null): boolean {
    if (raw === null) return false
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      return false
    }
    if (!isObj(data)) return false
    if (isObj(data.touches)) {
      for (const [k, v] of Object.entries(data.touches)) {
        if (typeof v === 'number' && Number.isFinite(v) && (touches.get(k) ?? 0) < v) touches.set(k, v)
      }
    }
    const before = JSON.stringify([...plans])
    const merged = new Map<Id, ReturnPlan>()
    if (isObj(data.plans)) {
      for (const [id, p] of Object.entries(data.plans)) {
        if (isObj(p) && typeof p.at === 'number' && Number.isFinite(p.at) && typeof p.presence === 'string' && p.presence in PRESENCE_META) {
          merged.set(id, { at: p.at, presence: p.presence as Presence })
        }
      }
    }
    for (const [id, op] of planOps) {
      if (op === null) merged.delete(id)
      else merged.set(id, op)
    }
    plans.clear()
    for (const [id, p] of merged) plans.set(id, p)
    return JSON.stringify([...plans]) !== before
  }

  function writeMeta() {
    mergeMeta(safeGet(META_KEY))
    pruneTouches(now().getTime())
    const json = JSON.stringify({ touches: Object.fromEntries(touches), plans: Object.fromEntries(plans) })
    if (json === lastMetaRaw || safeSet(META_KEY, json)) {
      lastMetaRaw = json
      planOps.clear()
    }
  }

  function touch(kind: 'task' | 'member', id: Id) {
    touches.set(`${kind}:${id}`, now().getTime())
    writeMeta() // immediate: other tabs' demo must see it before the workspace save lands
  }

  function touchedRecently(kind: 'task' | 'member', id: Id, windowMs = MANAGER_TOUCH_WINDOW_MS): boolean {
    const at = touches.get(`${kind}:${id}`)
    return at !== undefined && now().getTime() - at < windowMs
  }

  function setPlan(id: Id, plan: ReturnPlan | null) {
    if (plan) plans.set(id, plan)
    else plans.delete(id)
    planOps.set(id, plan)
    writeMeta()
  }

  if (storage.subscribe) {
    storage.subscribe(META_KEY, () => {
      if (mergeMeta(safeGet(META_KEY))) for (const cb of adoptHooks) cb()
    })
  }

  // ---- state / persistence ---------------------------------------------------

  function writeState(): boolean {
    if (!state) return false
    const json = JSON.stringify(state)
    if (json !== lastRaw && !safeSet(STORAGE_KEY, json)) return false
    lastRaw = json
    dirtyTasks.clear()
    deletedTasks.clear()
    dirtyMembers.clear()
    deletedMembers.clear()
    dirtyActivity.clear()
    dirtyMeetings.clear()
    return true
  }

  function ensure(): Persisted {
    if (!state) {
      const loaded = loadPersisted(storage, now().toISOString())
      if (loaded.kind === 'ok') {
        state = loaded.state
        lastRaw = loaded.raw
        if (loaded.repaired) {
          backupCorrupt(storage, loaded.raw)
          pushSystemActivity(state, '저장된 데이터 일부를 바로잡았어요')
          writeState()
        }
      } else {
        const seeded = buildSeed(now())
        if (loaded.kind === 'corrupt') {
          backupCorrupt(storage, loaded.raw)
          pushSystemActivity(seeded, '저장된 데이터를 불러오지 못해 초기화했어요')
        }
        state = seeded
        writeState()
      }
      lastMetaRaw = safeGet(META_KEY)
      mergeMeta(lastMetaRaw)
    }
    return state
  }

  function pushSystemActivity(target: Persisted, message: string) {
    const ws = target.workspace
    ws.activity.push({ id: uid('a', (id) => ws.activity.some((a) => a.id === id)), at: iso(), kind: 'system', actorId: null, message })
    if (ws.activity.length > MAX_ACTIVITY) ws.activity.splice(0, ws.activity.length - MAX_ACTIVITY)
  }

  /**
   * If another tab wrote the workspace since we last looked, merge it with our state: its data is the
   * base, our unsaved local changes win per entity, numbers and desks are de-duplicated, and the
   * resulting differences are emitted. Returns true when this tab must write the merged result back.
   */
  function syncFromStorage(): boolean {
    if (state === null) return false
    const raw = safeGet(STORAGE_KEY)
    if (raw === null || raw === lastRaw) return false
    lastRaw = raw
    const parsed = parsePersisted(raw, iso())
    if (!parsed) return true // unusable remote data: our state replaces it
    const prev = state.workspace
    const remote = parsed.state
    let fixed = false

    // members: remote base, minus our deletions, with our dirty versions on top
    const localMembers = new Map(prev.members.map((m) => [m.id, m]))
    const members: Member[] = []
    const seenMembers = new Set<Id>()
    for (const m of remote.workspace.members) {
      if (deletedMembers.has(m.id)) continue
      seenMembers.add(m.id)
      members.push(dirtyMembers.has(m.id) ? clone(localMembers.get(m.id) ?? m) : m)
    }
    for (const id of dirtyMembers) {
      const m = localMembers.get(id)
      if (m && !seenMembers.has(id) && !deletedMembers.has(id)) members.push(clone(m))
    }
    // desks must stay unique: remote members keep theirs, our unsaved ones move (or leave when full)
    const used = new Set(members.filter((m) => !dirtyMembers.has(m.id)).map((m) => m.deskId))
    for (let i = members.length - 1; i >= 0; i--) {
      const m = members[i]
      if (!dirtyMembers.has(m.id)) continue
      if (used.has(m.deskId)) {
        const free = OFFICE.desks.find((d) => !used.has(d.id))
        fixed = true
        if (!free) {
          members.splice(i, 1)
          continue
        }
        m.deskId = free.id
      }
      used.add(m.deskId)
    }
    const memberIds = new Set(members.map((m) => m.id))

    // tasks
    const localTasks = new Map(prev.tasks.map((t) => [t.id, t]))
    const tasks: Task[] = []
    const seenTasks = new Set<Id>()
    for (const t of remote.workspace.tasks) {
      if (deletedTasks.has(t.id)) continue
      seenTasks.add(t.id)
      tasks.push(dirtyTasks.has(t.id) ? clone(localTasks.get(t.id) ?? t) : t)
    }
    for (const id of dirtyTasks) {
      const t = localTasks.get(id)
      if (t && !seenTasks.has(id) && !deletedTasks.has(id)) tasks.push(clone(t))
    }
    let nextNumber = Math.max(state.nextNumber, remote.nextNumber)
    for (const t of tasks) nextNumber = Math.max(nextNumber, t.number + 1)
    const taken = new Set(tasks.filter((t) => !dirtyTasks.has(t.id)).map((t) => t.number))
    for (const t of tasks) {
      if (!dirtyTasks.has(t.id)) continue
      if (taken.has(t.number)) {
        t.number = nextNumber++
        fixed = true
      }
      taken.add(t.number)
    }
    for (const t of tasks) {
      if (t.assigneeId !== null && !memberIds.has(t.assigneeId)) {
        t.assigneeId = null
        fixed = true
      }
    }

    // meetings: remote base, our unsaved versions on top; one ongoing at most; an ongoing one only names who/what still exists
    const localMeetings = new Map(prev.meetings.map((m) => [m.id, m]))
    const meetings: Meeting[] = []
    const seenMeetings = new Set<Id>()
    for (const m of remote.workspace.meetings) {
      seenMeetings.add(m.id)
      const mine = dirtyMeetings.has(m.id) ? localMeetings.get(m.id) : undefined
      if (!mine || m.status === 'ended') {
        meetings.push(m) // an ended meeting always beats an ongoing copy (e.g. one this tab edited after another tab ended it)
      } else if (mine.status === 'ended') {
        meetings.push(clone(mine))
      } else {
        // both copies ongoing: keep only what both still have (someone / something removed on either side stays removed)
        const merged = clone(m)
        merged.attendeeIds = m.attendeeIds.filter((id) => mine.attendeeIds.includes(id))
        merged.agendaTaskIds = m.agendaTaskIds.filter((id) => mine.agendaTaskIds.includes(id))
        meetings.push(merged)
      }
    }
    for (const id of dirtyMeetings) {
      const m = localMeetings.get(id)
      if (m && !seenMeetings.has(id)) meetings.push(clone(m))
    }
    const wasOngoing = new Set(meetings.filter((m) => m.status === 'ongoing').map((m) => m.id))
    if (normalizeMeetings(meetings, iso())) fixed = true
    const winner = meetings.find((m) => m.status === 'ongoing')
    let closedHere = 0
    for (const m of meetings) {
      if (m.status !== 'ended' || !wasOngoing.has(m.id)) continue
      if (dirtyMeetings.has(m.id) && !seenMeetings.has(m.id)) closedHere++
      // two tabs started a meeting at once: the loser is closed and its people go back to work
      for (const id of m.attendeeIds) {
        const member = members.find((x) => x.id === id)
        if (member && member.presence === 'meeting' && !winner?.attendeeIds.includes(id)) member.presence = 'working'
      }
    }
    const taskIdSet = new Set(tasks.map((t) => t.id))
    for (const m of meetings) {
      if (m.status !== 'ongoing') continue
      const a = m.attendeeIds.filter((id) => memberIds.has(id))
      const g = m.agendaTaskIds.filter((id) => taskIdSet.has(id))
      if (a.length !== m.attendeeIds.length || g.length !== m.agendaTaskIds.length) {
        m.attendeeIds = a
        m.agendaTaskIds = g
        fixed = true
      }
    }

    // activity: union by id, oldest first, capped
    const activityIds = new Set(remote.workspace.activity.map((a) => a.id))
    const activity = [...remote.workspace.activity]
    for (const a of prev.activity) if (dirtyActivity.has(a.id) && !activityIds.has(a.id)) activity.push(a)
    for (let i = 0; i < closedHere; i++) {
      // this tab's meeting lost against one another tab started at the same time
      const notice: Activity = {
        id: uid('a', (id) => activity.some((a) => a.id === id)),
        at: iso(),
        kind: 'system',
        actorId: null,
        message: '다른 탭에서 시작한 회의가 있어 이 회의를 닫았어요',
      }
      activity.push(notice)
      dirtyActivity.add(notice.id)
    }
    activity.sort((a, b) => a.at.localeCompare(b.at))
    if (activity.length > MAX_ACTIVITY) activity.splice(0, activity.length - MAX_ACTIVITY)

    const next: Workspace = { projects: remote.workspace.projects, members, tasks, meetings, activity }
    state = { version: 1, workspace: next, nextNumber }

    // tell listeners what differs from what they last saw
    const changes: Change[] = []
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
    const oldProjects = new Map(prev.projects.map((p) => [p.id, p]))
    for (const project of next.projects) if (!same(oldProjects.get(project.id), project)) changes.push({ type: 'project_upsert', project })
    const oldMembers = new Map(prev.members.map((m) => [m.id, m]))
    for (const m of next.members) if (!same(oldMembers.get(m.id), m)) changes.push({ type: 'member_upsert', member: m })
    for (const m of prev.members) if (!memberIds.has(m.id)) changes.push({ type: 'member_delete', id: m.id })
    const nextTaskIds = new Set(tasks.map((t) => t.id))
    for (const t of next.tasks) if (!same(localTasks.get(t.id), t)) changes.push({ type: 'task_upsert', task: t })
    for (const t of prev.tasks) if (!nextTaskIds.has(t.id)) changes.push({ type: 'task_delete', id: t.id })
    const oldMeetings = new Map(prev.meetings.map((m) => [m.id, m]))
    for (const m of next.meetings) if (!same(oldMeetings.get(m.id), m)) changes.push({ type: 'meeting_upsert', meeting: m })
    const knownActivity = new Set(prev.activity.map((a) => a.id))
    for (const a of next.activity) if (!knownActivity.has(a.id)) changes.push({ type: 'activity', activity: a })
    emitAll(changes)
    for (const cb of adoptHooks) cb()

    return fixed || dirtyTasks.size > 0 || deletedTasks.size > 0 || dirtyMembers.size > 0 || deletedMembers.size > 0 || dirtyActivity.size > 0 || dirtyMeetings.size > 0
  }

  /** Writes the workspace now. Anything another tab wrote in the meantime is merged first, never overwritten. */
  function persistNow() {
    if (persistTimer !== null) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    if (!state) return
    syncFromStorage()
    writeState()
  }

  if (storage.subscribe) {
    storage.subscribe(STORAGE_KEY, () => {
      if (syncFromStorage()) persistNow()
    })
  }

  function flush() {
    persistNow()
  }

  function schedulePersist() {
    if (persistTimer !== null) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      persistNow()
    }, PERSIST_DEBOUNCE_MS)
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', flush)
  }

  // ---- helpers ---------------------------------------------------------------

  function uid(prefix: string, taken: (id: string) => boolean): string {
    for (let i = 0; i < 8; i++) {
      const id = `${prefix}_${Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0')}`
      if (!taken(id)) return id
    }
    let id: string
    do id = `${prefix}_x${(idFallback++).toString(36)}`
    while (taken(id))
    return id
  }

  const iso = () => now().toISOString()
  const findTask = (id: Id) => ensure().workspace.tasks.find((t) => t.id === id)
  const findMember = (id: Id) => ensure().workspace.members.find((m) => m.id === id)
  const findProject = (id: Id) => ensure().workspace.projects.find((p) => p.id === id)
  const refOf = (t: Task) => taskKey(t, findProject(t.projectId)?.key)
  const nameOf = (id: Id | null | undefined) => (id ? findMember(id)?.name ?? '팀원' : '매니저')

  /** Order value that puts a task on top of an assignee's stack (or the backlog when null). */
  const topOrder = (assigneeId: Id | null) => stackTop(ensure().workspace.tasks, assigneeId)

  const lookup: Lookup = {
    hasProject: (id) => findProject(id) !== undefined,
    hasMember: (id) => findMember(id) !== undefined,
    hasTask: (id) => findTask(id) !== undefined,
    deskOwner: (deskId) => ensure().workspace.members.find((m) => m.deskId === deskId)?.id,
    memberCount: () => ensure().workspace.members.length,
  }

  interface ActivityDraft {
    kind: ActivityKind
    message: string
    actorId?: Id | null
    taskId?: Id
    memberId?: Id
  }

  /** Records the activity (if any), schedules persistence and notifies listeners. */
  function commit(changes: Change[], draft?: ActivityDraft | null) {
    const ws = ensure().workspace
    const out = [...changes]
    if (draft) {
      const activity: Activity = {
        id: uid('a', (id) => ws.activity.some((a) => a.id === id)),
        at: iso(),
        kind: draft.kind,
        actorId: draft.actorId ?? null,
        message: draft.message,
      }
      if (draft.taskId) activity.taskId = draft.taskId
      if (draft.memberId) activity.memberId = draft.memberId
      ws.activity.push(activity)
      if (ws.activity.length > MAX_ACTIVITY) ws.activity.splice(0, ws.activity.length - MAX_ACTIVITY)
      out.push({ type: 'activity', activity })
    }
    for (const c of out) {
      if (c.type === 'task_upsert') {
        dirtyTasks.add(c.task.id)
        deletedTasks.delete(c.task.id)
      } else if (c.type === 'task_delete') {
        deletedTasks.add(c.id)
        dirtyTasks.delete(c.id)
      } else if (c.type === 'member_upsert') {
        dirtyMembers.add(c.member.id)
        deletedMembers.delete(c.member.id)
      } else if (c.type === 'member_delete') {
        deletedMembers.add(c.id)
        dirtyMembers.delete(c.id)
      } else if (c.type === 'meeting_upsert') dirtyMeetings.add(c.meeting.id)
      else if (c.type === 'activity') dirtyActivity.add(c.activity.id)
    }
    schedulePersist()
    emitAll(out)
  }

  function emitAll(out: Change[]) {
    for (const change of out) {
      for (const listener of [...listeners]) {
        try {
          listener(clone(change))
        } catch (e) {
          console.error('mock data source: listener failed', e)
        }
      }
    }
  }

  // ---- tasks -----------------------------------------------------------------

  function createTask(input: TaskInput, meta: MutationMeta = {}): Task {
    const s = ensure()
    const clean = checkTaskInput(input, lookup)
    const at = iso()
    const taken = (id: string) => s.workspace.tasks.some((t) => t.id === id)
    const task: Task = {
      id: uid(meta.demo ? DEMO_TASK_PREFIX : 't', taken),
      number: s.nextNumber++,
      title: clean.title,
      description: clean.description,
      status: clean.status,
      priority: clean.priority,
      estimate: clean.estimate,
      projectId: clean.projectId,
      assigneeId: clean.assigneeId,
      dueDate: clean.dueDate,
      order: topOrder(clean.assigneeId),
      createdAt: at,
      updatedAt: at,
      completedAt: clean.status === 'done' ? at : null,
      onAgenda: false,
    }
    s.workspace.tasks.push(task)
    if (!meta.demo) touch('task', task.id)

    let draft: ActivityDraft | null = null
    if (meta.message !== null) {
      draft = {
        kind: meta.kind ?? 'task_created',
        message: meta.message ?? taskCreatedMessage(refOf(task), clean.assigneeId ? nameOf(clean.assigneeId) : null),
        actorId: meta.actorId ?? null,
        taskId: task.id,
      }
    }
    commit([{ type: 'task_upsert', task }], draft)
    return clone(task)
  }

  function updateTask(id: Id, patch: TaskPatch, meta: MutationMeta = {}): Task {
    const task = findTask(id)
    if (!task) throw new DataError(notFound('task'), 'not_found')
    if (!isObj(patch)) throw new DataError('수정할 내용이 올바르지 않아요')

    if (!meta.demo) touch('task', id)
    const checked = checkTaskPatch(patch, lookup)
    const { next, changed } = applyTaskPatch(task, checked, { at: iso(), topOrder })
    if (changed.length === 0) return clone(task)
    Object.assign(task, next)

    let draft: ActivityDraft | null = null
    if (meta.message !== null) {
      const auto = taskChangeActivity(task, changed, refOf(task), {
        actorId: meta.actorId ?? null,
        actorName: meta.actorId ? nameOf(meta.actorId) : null,
        assigneeName: task.assigneeId ? nameOf(task.assigneeId) : null,
      })
      if (auto || meta.message) {
        draft = {
          kind: meta.kind ?? auto?.kind ?? 'task_updated',
          message: meta.message ?? auto?.message ?? '',
          actorId: meta.actorId ?? null,
          taskId: task.id,
          ...(auto?.memberId ? { memberId: auto.memberId } : {}),
        }
      }
    }
    commit([{ type: 'task_upsert', task }], draft)
    return clone(task)
  }

  function deleteTask(id: Id, opts: { silent?: boolean; demo?: boolean } = {}): void {
    const s = ensure()
    const index = s.workspace.tasks.findIndex((t) => t.id === id)
    if (index < 0) throw new DataError(notFound('task'), 'not_found')
    const [task] = s.workspace.tasks.splice(index, 1)
    if (!opts.demo) touch('task', id)
    const draft: ActivityDraft | null = opts.silent ? null : { kind: 'task_deleted', message: taskDeletedMessage(refOf(task), task.title), actorId: null }
    const changes: Change[] = [{ type: 'task_delete', id }]
    const shrunk = dropAgendaTask(ongoingMeeting(s.workspace.meetings), id)
    if (shrunk) changes.push({ type: 'meeting_upsert', meeting: storeMeeting(shrunk) })
    commit(changes, draft)
  }

  // ---- members ---------------------------------------------------------------

  function createMember(input: MemberInput): Member {
    const s = ensure()
    const clean = checkMemberInput(input, lookup, MAX_MEMBERS)
    const avatarVariant = clean.avatarVariant ?? Math.floor(random() * AVATAR_VARIANTS)
    const member: Member = {
      id: uid('m', (id) => s.workspace.members.some((m) => m.id === id)),
      name: clean.name,
      role: clean.role,
      color: clean.color,
      capacity: clean.capacity,
      deskId: clean.deskId,
      presence: 'working',
      avatarVariant,
      joinedAt: iso(),
    }
    s.workspace.members.push(member)
    touch('member', member.id)
    commit([{ type: 'member_upsert', member }], { kind: 'member_joined', message: memberJoinedMessage(member.name), actorId: null, memberId: member.id })
    return clone(member)
  }

  function updateMember(id: Id, patch: MemberPatch): Member {
    const member = findMember(id)
    if (!member) throw new DataError(notFound('member'), 'not_found')
    if (!isObj(patch)) throw new DataError('수정할 내용이 올바르지 않아요')

    touch('member', id) // any manager patch counts, not only presence (same rule as the server)
    const { next, changed, onlyPresence } = applyMemberPatch(member, checkMemberPatch(patch, lookup, id))
    if (changed.length === 0) return clone(member)
    Object.assign(member, next)

    const activity = memberChangeActivity(id, member.name, member.presence, onlyPresence)
    commit([{ type: 'member_upsert', member }], { ...activity, actorId: null })
    return clone(member)
  }

  function deleteMember(id: Id, reassign: Reassign): void {
    const s = ensure()
    const member = findMember(id)
    if (!member) throw new DataError(notFound('member'), 'not_found')
    const how = checkReassign(reassign, lookup, id)
    const target = how.mode === 'member' ? findMember(how.memberId) : undefined

    const { tasks: moved, movedOpen } = planMemberRemoval(id, s.workspace.tasks, how, iso())
    const changes: Change[] = []
    for (const copy of moved) {
      const task = findTask(copy.id)!
      Object.assign(task, copy)
      touch('task', task.id)
      changes.push({ type: 'task_upsert', task })
    }
    s.workspace.members.splice(s.workspace.members.indexOf(member), 1)
    changes.push({ type: 'member_delete', id })
    const shrunk = dropAttendee(ongoingMeeting(s.workspace.meetings), id)
    if (shrunk) changes.push({ type: 'meeting_upsert', meeting: storeMeeting(shrunk) })

    commit(changes, { kind: 'member_left', message: memberLeftMessage(member.name, movedOpen, target?.name ?? null), actorId: null, memberId: id })
  }

  function setPresence(ids: Id[], presence: Presence, activity?: { message: string; memberId?: Id } | null): void {
    const changes: Change[] = []
    for (const id of ids) {
      const member = findMember(id)
      if (!member || member.presence === presence) continue
      member.presence = presence
      changes.push({ type: 'member_upsert', member })
    }
    if (changes.length === 0) return
    commit(changes, activity ? { kind: 'presence', message: activity.message, actorId: null, memberId: activity.memberId } : null)
  }

  // ---- meetings --------------------------------------------------------------

  /** Writes a planned meeting back into the live state (same object identity per id) and returns it. */
  function storeMeeting(next: Meeting): Meeting {
    const meetings = ensure().workspace.meetings
    const existing = meetings.find((m) => m.id === next.id)
    if (existing) return Object.assign(existing, next)
    meetings.push(next)
    return next
  }

  function startMeeting(input: MeetingStart): Meeting {
    const s = ensure()
    const { title, attendeeIds } = checkMeetingStart(input, lookup)
    if (ongoingMeeting(s.workspace.meetings)) throw new DataError(MEETING_ONGOING, 'conflict')

    const plan = planMeetingStart({
      id: uid('mt', (id) => s.workspace.meetings.some((m) => m.id === id)),
      title,
      attendeeIds,
      tasks: s.workspace.tasks,
      members: s.workspace.members,
      at: iso(),
    })
    const meeting = storeMeeting(plan.meeting)
    const changes: Change[] = []
    for (const copy of plan.members) {
      const member = findMember(copy.id)!
      Object.assign(member, copy)
      touch('member', member.id) // the manager moved them: demo mode keeps its hands off for a while
      setPlan(member.id, null) // no planned return from an earlier informal meeting / break
      changes.push({ type: 'member_upsert', member })
    }
    changes.push({ type: 'meeting_upsert', meeting })
    commit(changes, { kind: 'meeting_started', message: plan.message, actorId: null })
    return clone(meeting)
  }

  function endMeeting(id: Id, result: MeetingEnd): Meeting {
    const s = ensure()
    const current = s.workspace.meetings.find((m) => m.id === id)
    if (!current) throw new DataError(notFound('meeting'), 'not_found')
    if (current.status !== 'ongoing') throw new DataError(MEETING_ENDED, 'conflict')
    const { notes, outcomes } = checkMeetingEnd(result, current.agendaTaskIds, lookup)

    const plan = planMeetingEnd({ meeting: current, notes, outcomes, tasks: s.workspace.tasks, members: s.workspace.members, at: iso() })
    const changes: Change[] = []
    for (const copy of plan.tasks) {
      const task = findTask(copy.id)!
      Object.assign(task, copy)
      touch('task', task.id)
      changes.push({ type: 'task_upsert', task })
    }
    const meeting = storeMeeting(plan.meeting)
    for (const memberId of meeting.attendeeIds) if (findMember(memberId)) touch('member', memberId)
    for (const copy of plan.members) {
      const member = findMember(copy.id)!
      Object.assign(member, copy)
      setPlan(member.id, null)
      changes.push({ type: 'member_upsert', member })
    }
    changes.push({ type: 'meeting_upsert', meeting })
    normalizeMeetings(s.workspace.meetings, meeting.endedAt ?? iso())
    commit(changes, { kind: 'meeting_ended', message: plan.message, actorId: null })
    return clone(meeting)
  }

  // ---- misc ------------------------------------------------------------------

  function reset(): Workspace {
    // A reset replaces everything: no merge with whatever is stored, and other tabs adopt the seed.
    state = buildSeed(now())
    lastRaw = safeGet(STORAGE_KEY)
    if (persistTimer !== null) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    writeState()
    touches.clear()
    plans.clear()
    planOps.clear()
    lastMetaRaw = JSON.stringify({ touches: {}, plans: {} })
    safeSet(META_KEY, lastMetaRaw)
    for (const cb of resetHooks) cb()
    return clone(state.workspace)
  }

  return {
    get ws() {
      return ensure().workspace
    },
    get nextNumber() {
      return ensure().nextNumber
    },
    snapshot: () => clone(ensure().workspace),
    createTask,
    updateTask,
    deleteTask,
    createMember,
    updateMember,
    deleteMember,
    startMeeting,
    endMeeting,
    setPresence,
    reset,
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    flush,
    onReset: (cb) => void resetHooks.push(cb),
    onAdopt: (cb) => void adoptHooks.push(cb),
    touchedRecently,
    getPlans: () => (ensure(), plans),
    setPlan,
  }
}
