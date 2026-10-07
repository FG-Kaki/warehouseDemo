// The "backend" of the mock source: validated, synchronous mutations over an in-memory workspace.
// index.ts wraps these with latency; demo.ts drives them to simulate teammates. Every mutation
// goes through commit(): activity, persistence and change notification all happen in one place.
import { DataError } from '../DataSource'
import { AVATAR_VARIANTS, ESTIMATES, PRESENCE_META, PRIORITY_META, STATUSES } from '../meta'
import { taskKey } from '../selectors'
import type {
  Activity,
  ActivityKind,
  AgendaOutcome,
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
import { MAX_MEMBERS, OFFICE, deskById } from '../../office/layout'
import { buildSeed } from './seed'
import { META_KEY, STORAGE_KEY, backupCorrupt, loadPersisted, normalizeMeetings, parsePersisted, type Persisted, type StorageLike } from './storage'
import { eul, iGa, refObject, STATUS_TO, taskObject } from './text'

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
export const MANAGER_TOUCH_WINDOW_MS = 120_000
/** Id prefix of tasks created by demo mode; only those are ever pruned automatically. */
export const DEMO_TASK_PREFIX = 'td'

const MAX_ACTIVITY = 100
const PERSIST_DEBOUNCE_MS = 200

const clone = <T>(v: T): T => structuredClone(v)
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

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
  function topOrder(assigneeId: Id | null): number {
    let max = 0
    for (const t of ensure().workspace.tasks) if (t.assigneeId === assigneeId && t.order > max) max = t.order
    return max + 1
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

  // ---- validation ------------------------------------------------------------

  function checkTitle(v: unknown): string {
    const title = typeof v === 'string' ? v.trim() : ''
    if (title.length === 0) throw new DataError('제목을 입력해 주세요')
    if (title.length > 120) throw new DataError('제목은 120자 이하로 입력해 주세요')
    return title
  }

  function checkDescription(v: unknown): string {
    if (typeof v !== 'string') throw new DataError('설명이 올바르지 않아요')
    if (v.length > 2000) throw new DataError('설명은 2000자 이하로 입력해 주세요')
    return v
  }

  function checkStatus(v: unknown): Task['status'] {
    if (!STATUSES.includes(v as Task['status'])) throw new DataError('올바르지 않은 상태예요')
    return v as Task['status']
  }

  function checkPriority(v: unknown): Task['priority'] {
    if (typeof v !== 'string' || !(v in PRIORITY_META)) throw new DataError('올바르지 않은 우선순위예요')
    return v as Task['priority']
  }

  function checkEstimate(v: unknown): Task['estimate'] {
    if (!ESTIMATES.includes(v as Task['estimate'])) throw new DataError('예상 포인트가 올바르지 않아요')
    return v as Task['estimate']
  }

  function checkDueDate(v: unknown): string | null {
    if (v === null) return null
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const d = new Date(`${v}T00:00:00Z`)
      if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v) return v
    }
    throw new DataError('마감일 형식이 올바르지 않아요')
  }

  function checkProject(v: unknown): Id {
    if (typeof v !== 'string' || !findProject(v)) throw new DataError('프로젝트를 찾을 수 없어요')
    return v
  }

  function checkAssignee(v: unknown): Id | null {
    if (v === null) return null
    if (typeof v !== 'string' || !findMember(v)) throw new DataError('팀원을 찾을 수 없어요')
    return v
  }

  function checkOrder(v: unknown): number {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new DataError('순서가 올바르지 않아요')
    return v
  }

  function checkName(v: unknown): string {
    const name = typeof v === 'string' ? v.trim() : ''
    if (name.length === 0) throw new DataError('이름을 입력해 주세요')
    if (name.length > 30) throw new DataError('이름은 30자 이하로 입력해 주세요')
    return name
  }

  function checkRole(v: unknown): string {
    const role = typeof v === 'string' ? v.trim() : ''
    if (role.length > 30) throw new DataError('역할은 30자 이하로 입력해 주세요')
    return role || '팀원'
  }

  function checkColor(v: unknown): string {
    if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) throw new DataError('색상이 올바르지 않아요')
    return v
  }

  function checkCapacity(v: unknown): number {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 40) throw new DataError('주간 여유량은 1~40 사이로 입력해 주세요')
    return v
  }

  function checkPresence(v: unknown): Presence {
    if (typeof v !== 'string' || !(v in PRESENCE_META)) throw new DataError('올바르지 않은 상태예요')
    return v as Presence
  }

  function checkVariant(v: unknown): number {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new DataError('아바타 모양이 올바르지 않아요')
    return v
  }

  function checkDesk(deskId: unknown, selfId?: Id): string {
    if (typeof deskId !== 'string' || !deskById(deskId)) throw new DataError('존재하지 않는 자리예요')
    const owner = ensure().workspace.members.find((m) => m.deskId === deskId)
    if (owner && owner.id !== selfId) throw new DataError('이미 사용 중인 자리예요', 'conflict')
    return deskId
  }

  // ---- tasks -----------------------------------------------------------------

  function createTask(input: TaskInput, meta: MutationMeta = {}): Task {
    const s = ensure()
    if (!isObj(input)) throw new DataError('제목을 입력해 주세요')
    const title = checkTitle(input.title)
    const projectId = checkProject(input.projectId)
    const assigneeId = input.assigneeId === undefined ? null : checkAssignee(input.assigneeId)
    const description = input.description === undefined ? '' : checkDescription(input.description)
    const status = input.status === undefined ? 'todo' : checkStatus(input.status)
    const priority = input.priority === undefined ? 'medium' : checkPriority(input.priority)
    const estimate = input.estimate === undefined ? 3 : checkEstimate(input.estimate)
    const dueDate = input.dueDate === undefined ? null : checkDueDate(input.dueDate)

    const at = iso()
    const taken = (id: string) => s.workspace.tasks.some((t) => t.id === id)
    const task: Task = {
      id: uid(meta.demo ? DEMO_TASK_PREFIX : 't', taken),
      number: s.nextNumber++,
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
    s.workspace.tasks.push(task)
    if (!meta.demo) touch('task', task.id)

    let draft: ActivityDraft | null = null
    if (meta.message !== null) {
      const ref = refOf(task)
      draft = {
        kind: meta.kind ?? 'task_created',
        message: meta.message ?? (assigneeId ? `새 작업 ${refObject(ref)} 만들어 ${nameOf(assigneeId)} 님에게 배정했어요` : `새 작업 ${refObject(ref)} 만들었어요`),
        actorId: meta.actorId ?? null,
        taskId: task.id,
      }
    }
    commit([{ type: 'task_upsert', task }], draft)
    return clone(task)
  }

  const CONTENT_KEYS: (keyof Task)[] = ['title', 'description', 'priority', 'estimate', 'projectId', 'dueDate']

  function updateTask(id: Id, patch: TaskPatch, meta: MutationMeta = {}): Task {
    const task = findTask(id)
    if (!task) throw new DataError('작업을 찾을 수 없어요', 'not_found')
    if (!isObj(patch)) throw new DataError('수정할 내용이 올바르지 않아요')

    if (!meta.demo) touch('task', id)
    const next: Partial<Task> = {}
    if (patch.title !== undefined) next.title = checkTitle(patch.title)
    if (patch.description !== undefined) next.description = checkDescription(patch.description)
    if (patch.status !== undefined) next.status = checkStatus(patch.status)
    if (patch.priority !== undefined) next.priority = checkPriority(patch.priority)
    if (patch.estimate !== undefined) next.estimate = checkEstimate(patch.estimate)
    if (patch.projectId !== undefined) next.projectId = checkProject(patch.projectId)
    if (patch.assigneeId !== undefined) next.assigneeId = checkAssignee(patch.assigneeId)
    if (patch.dueDate !== undefined) next.dueDate = checkDueDate(patch.dueDate)
    if (patch.order !== undefined) next.order = checkOrder(patch.order)
    if (patch.onAgenda !== undefined) {
      if (typeof patch.onAgenda !== 'boolean') throw new DataError('안건 값이 올바르지 않아요')
      next.onAgenda = patch.onAgenda
    }
    // an agenda item is an open task: asking for it on a done task (or while completing it) is an error
    if (next.onAgenda === true && (next.status ?? task.status) === 'done') throw new DataError('완료된 작업은 안건으로 올릴 수 없어요')

    const at = iso()
    if (next.assigneeId !== undefined && next.assigneeId !== task.assigneeId && next.order === undefined) {
      next.order = topOrder(next.assigneeId)
    }
    if (next.status !== undefined && next.status !== task.status) {
      next.completedAt = next.status === 'done' ? at : null
    }
    if (next.status === 'done' && next.onAgenda === undefined) next.onAgenda = false // completing takes it off the agenda

    const changed = (Object.keys(next) as (keyof Task)[]).filter((k) => next[k] !== task[k])
    if (changed.length === 0) return clone(task)

    Object.assign(task, next, { updatedAt: at })

    let draft: ActivityDraft | null = null
    if (meta.message !== null) {
      const ref = refOf(task)
      const subject = taskObject(ref, task.title)
      let kind: ActivityKind | null = null
      let message = ''
      if (changed.includes('assigneeId')) {
        kind = 'task_assigned'
        message = task.assigneeId ? `${subject} ${nameOf(task.assigneeId)} 님에게 배정했어요` : `${subject} 백로그로 돌렸어요`
      } else if (changed.includes('status')) {
        kind = 'task_status'
        message = task.status === 'done' ? `${subject} 완료 처리했어요` : `${subject} ${STATUS_TO[task.status]} 옮겼어요`
      } else if (changed.some((k) => CONTENT_KEYS.includes(k))) {
        kind = 'task_updated'
        message = `${subject} 수정했어요`
      }
      if (kind || meta.message) {
        draft = {
          kind: meta.kind ?? kind ?? 'task_updated',
          message: meta.message ?? message,
          actorId: meta.actorId ?? null,
          taskId: task.id,
          ...(kind === 'task_assigned' && task.assigneeId ? { memberId: task.assigneeId } : {}),
        }
      }
    }
    commit([{ type: 'task_upsert', task }], draft)
    return clone(task)
  }

  function deleteTask(id: Id, opts: { silent?: boolean; demo?: boolean } = {}): void {
    const s = ensure()
    const index = s.workspace.tasks.findIndex((t) => t.id === id)
    if (index < 0) throw new DataError('작업을 찾을 수 없어요', 'not_found')
    const [task] = s.workspace.tasks.splice(index, 1)
    if (!opts.demo) touch('task', id)
    const draft: ActivityDraft | null = opts.silent
      ? null
      : { kind: 'task_deleted', message: `${taskObject(refOf(task), task.title)} 삭제했어요`, actorId: null }
    const changes: Change[] = [{ type: 'task_delete', id }]
    const meeting = ongoingMeeting()
    if (meeting?.agendaTaskIds.includes(id)) {
      meeting.agendaTaskIds = meeting.agendaTaskIds.filter((x) => x !== id)
      changes.push({ type: 'meeting_upsert', meeting })
    }
    commit(changes, draft)
  }

  // ---- members ---------------------------------------------------------------

  function createMember(input: MemberInput): Member {
    const s = ensure()
    if (!isObj(input)) throw new DataError('이름을 입력해 주세요')
    const name = checkName(input.name)
    const role = checkRole(input.role)
    const color = checkColor(input.color)
    const capacity = checkCapacity(input.capacity)
    const avatarVariant = input.avatarVariant === undefined ? Math.floor(random() * AVATAR_VARIANTS) : checkVariant(input.avatarVariant)
    if (s.workspace.members.length >= MAX_MEMBERS) throw new DataError('자리가 모두 찼어요', 'conflict')
    let deskId: string
    if (input.deskId !== undefined) {
      deskId = checkDesk(input.deskId)
    } else {
      const used = new Set(s.workspace.members.map((m) => m.deskId))
      const free = OFFICE.desks.find((d) => !used.has(d.id))
      if (!free) throw new DataError('자리가 모두 찼어요', 'conflict')
      deskId = free.id
    }
    const member: Member = {
      id: uid('m', (id) => s.workspace.members.some((m) => m.id === id)),
      name,
      role,
      color,
      capacity,
      deskId,
      presence: 'working',
      avatarVariant,
      joinedAt: iso(),
    }
    s.workspace.members.push(member)
    touch('member', member.id)
    commit([{ type: 'member_upsert', member }], { kind: 'member_joined', message: `${name} 님이 합류했어요`, actorId: null, memberId: member.id })
    return clone(member)
  }

  const PRESENCE_MESSAGE: Record<Presence, string> = {
    working: '님이 작업을 시작했어요',
    meeting: '님이 회의에 들어갔어요',
    break: '님이 휴식 중이에요',
    away: '님이 자리를 비웠어요',
  }

  function updateMember(id: Id, patch: MemberPatch): Member {
    const member = findMember(id)
    if (!member) throw new DataError('팀원을 찾을 수 없어요', 'not_found')
    if (!isObj(patch)) throw new DataError('수정할 내용이 올바르지 않아요')

    touch('member', id) // any manager patch counts, not only presence (same rule as the server)
    const next: Partial<Member> = {}
    if (patch.name !== undefined) next.name = checkName(patch.name)
    if (patch.role !== undefined) next.role = checkRole(patch.role)
    if (patch.color !== undefined) next.color = checkColor(patch.color)
    if (patch.capacity !== undefined) next.capacity = checkCapacity(patch.capacity)
    if (patch.deskId !== undefined) next.deskId = checkDesk(patch.deskId, id)
    if (patch.presence !== undefined) next.presence = checkPresence(patch.presence)

    const changed = (Object.keys(next) as (keyof Member)[]).filter((k) => next[k] !== member[k])
    if (changed.length === 0) return clone(member)
    Object.assign(member, next)

    const onlyPresence = changed.length === 1 && changed[0] === 'presence'
    commit([{ type: 'member_upsert', member }], {
      kind: onlyPresence ? 'presence' : 'member_updated',
      message: onlyPresence ? `${member.name} ${PRESENCE_MESSAGE[member.presence]}` : `${member.name} 님의 정보를 수정했어요`,
      actorId: null,
      memberId: id,
    })
    return clone(member)
  }

  function deleteMember(id: Id, reassign: Reassign): void {
    const s = ensure()
    const member = findMember(id)
    if (!member) throw new DataError('팀원을 찾을 수 없어요', 'not_found')
    if (!isObj(reassign) || (reassign.mode !== 'backlog' && reassign.mode !== 'member')) throw new DataError('작업 처리 방법을 선택해 주세요')
    let target: Member | undefined
    if (reassign.mode === 'member') {
      target = findMember(reassign.memberId)
      if (!target) throw new DataError('작업을 넘겨받을 팀원을 찾을 수 없어요')
      if (target.id === id) throw new DataError('같은 팀원에게는 넘길 수 없어요')
    }

    const at = iso()
    const changes: Change[] = []
    let movedOpen = 0
    // Stable order: keep the member's own stack order when moving tasks to a new stack.
    const theirs = s.workspace.tasks.filter((t) => t.assigneeId === id).sort((a, b) => a.order - b.order)
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
      touch('task', task.id)
      changes.push({ type: 'task_upsert', task })
    }
    s.workspace.members.splice(s.workspace.members.indexOf(member), 1)
    changes.push({ type: 'member_delete', id })
    const meeting = ongoingMeeting()
    if (meeting?.attendeeIds.includes(id)) {
      meeting.attendeeIds = meeting.attendeeIds.filter((x) => x !== id)
      changes.push({ type: 'meeting_upsert', meeting })
    }

    let message = `${member.name} 님이 팀을 떠났어요`
    if (movedOpen > 0) {
      message = target
        ? `${member.name} 님이 팀을 떠나 작업 ${movedOpen}개를 ${target.name} 님에게 넘겼어요`
        : `${member.name} 님이 팀을 떠나 작업 ${movedOpen}개를 백로그로 옮겼어요`
    }
    commit(changes, { kind: 'member_left', message, actorId: null, memberId: id })
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

  const ongoingMeeting = (): Meeting | undefined => ensure().workspace.meetings.find((m) => m.status === 'ongoing')

  function startMeeting(input: MeetingStart): Meeting {
    const s = ensure()
    if (!isObj(input)) throw new DataError('회의 이름을 입력해 주세요')
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    if (title.length === 0) throw new DataError('회의 이름을 입력해 주세요')
    if (title.length > 60) throw new DataError('회의 이름은 60자 이하로 입력해 주세요')
    if (!Array.isArray(input.attendeeIds) || input.attendeeIds.length === 0) throw new DataError('참석자를 한 명 이상 골라 주세요')
    const attendees: Member[] = []
    for (const id of input.attendeeIds) {
      const member = typeof id === 'string' ? findMember(id) : undefined
      if (!member) throw new DataError('팀원을 찾을 수 없어요')
      if (attendees.includes(member)) throw new DataError('같은 참석자가 여러 번 들어 있어요')
      attendees.push(member)
    }
    if (ongoingMeeting()) throw new DataError('이미 회의가 진행 중이에요', 'conflict')

    const weight = (t: Task) => PRIORITY_META[t.priority].weight
    const agenda = s.workspace.tasks
      .filter((t) => t.onAgenda && t.status !== 'done')
      .sort((a, b) => weight(b) - weight(a) || a.number - b.number)
    const meeting: Meeting = {
      id: uid('mt', (id) => s.workspace.meetings.some((m) => m.id === id)),
      title,
      attendeeIds: attendees.map((m) => m.id),
      agendaTaskIds: agenda.map((t) => t.id),
      status: 'ongoing',
      startedAt: iso(),
      endedAt: null,
      notes: '',
      outcomes: [],
    }
    s.workspace.meetings.push(meeting)

    const changes: Change[] = []
    for (const member of attendees) {
      member.presence = 'meeting'
      touch('member', member.id) // the manager moved them: demo mode keeps its hands off for a while
      setPlan(member.id, null) // no planned return from an earlier informal meeting / break
      changes.push({ type: 'member_upsert', member })
    }
    changes.push({ type: 'meeting_upsert', meeting })
    commit(changes, {
      kind: 'meeting_started',
      message: `${title}${eul(title)} 시작했어요 · 참석 ${attendees.length}명 · 안건 ${agenda.length}건`,
      actorId: null,
    })
    return clone(meeting)
  }

  function endMeeting(id: Id, result: MeetingEnd): Meeting {
    const s = ensure()
    const meeting = s.workspace.meetings.find((m) => m.id === id)
    if (!meeting) throw new DataError('회의를 찾을 수 없어요', 'not_found')
    if (meeting.status !== 'ongoing') throw new DataError('이미 끝난 회의예요', 'conflict')
    if (!isObj(result)) throw new DataError('회의 결과가 올바르지 않아요')
    const notes = result.notes === undefined ? '' : result.notes
    if (typeof notes !== 'string') throw new DataError('회의 메모가 올바르지 않아요')
    if (notes.length > 2000) throw new DataError('회의록은 2000자 이하로 입력해 주세요')
    const rawOutcomes = result.outcomes === undefined ? [] : result.outcomes
    if (!Array.isArray(rawOutcomes)) throw new DataError('회의 결정이 올바르지 않아요')

    const outcomes: AgendaOutcome[] = []
    const decided = new Set<Id>()
    for (const raw of rawOutcomes) {
      if (!isObj(raw) || typeof raw.taskId !== 'string') throw new DataError('회의 결정이 올바르지 않아요')
      if (decided.has(raw.taskId)) throw new DataError('같은 작업에 결정이 여러 개 있어요')
      // a task deleted since the agenda was shown is skipped silently; any other task must be on the agenda
      const exists = findTask(raw.taskId) !== undefined
      if (!meeting.agendaTaskIds.includes(raw.taskId) && exists) throw new DataError('안건에 없는 작업이에요')
      decided.add(raw.taskId)
      switch (raw.action) {
        case 'assign':
          if (typeof raw.memberId !== 'string' || !findMember(raw.memberId)) throw new DataError('팀원을 찾을 수 없어요')
          if (exists) outcomes.push({ taskId: raw.taskId, action: 'assign', memberId: raw.memberId })
          break
        case 'status':
          {
            const status = checkStatus(raw.status)
            if (exists) outcomes.push({ taskId: raw.taskId, action: 'status', status })
          }
          break
        case 'backlog':
        case 'keep':
          if (exists) outcomes.push({ taskId: raw.taskId, action: raw.action }) // deleted tasks drop out of the record
          break
        default:
          throw new DataError('올바르지 않은 결정이에요')
      }
    }

    const at = iso()
    const changes: Change[] = []
    const byTask = new Map(outcomes.map((o) => [o.taskId, o]))
    const decisions = outcomes.filter((o) => o.action !== 'keep').length
    for (const taskId of meeting.agendaTaskIds) {
      const task = findTask(taskId)
      if (!task) continue // deleted meanwhile
      const outcome = byTask.get(taskId) ?? ({ taskId, action: 'keep' } as const)
      // outcomes apply to the task as it is now, even one completed during the meeting (a status outcome can reopen it)
      const before = JSON.stringify(task)
      if (outcome.action === 'assign') {
        if (task.assigneeId !== outcome.memberId) {
          task.assigneeId = outcome.memberId
          task.order = topOrder(outcome.memberId)
        }
      } else if (outcome.action === 'backlog') {
        if (task.assigneeId !== null) {
          task.assigneeId = null
          task.order = topOrder(null)
        }
        if (task.status === 'in_progress' || task.status === 'review') task.status = 'todo'
      } else if (outcome.action === 'status') {
        if (outcome.status !== task.status) {
          task.status = outcome.status
          task.completedAt = outcome.status === 'done' ? at : null
        }
      }
      if (outcome.action !== 'keep') task.onAgenda = false // not settled ('keep' / no outcome): stays on the agenda
      if (JSON.stringify(task) === before) continue // nothing changed: write and emit nothing
      task.updatedAt = at
      touch('task', task.id)
      changes.push({ type: 'task_upsert', task })
    }

    meeting.status = 'ended'
    meeting.endedAt = at
    meeting.notes = notes
    meeting.outcomes = outcomes
    for (const memberId of meeting.attendeeIds) {
      const member = findMember(memberId)
      if (!member) continue
      touch('member', memberId)
      if (member.presence !== 'meeting') continue // e.g. the manager sent them on a break meanwhile
      member.presence = 'working'
      setPlan(memberId, null)
      changes.push({ type: 'member_upsert', member })
    }
    changes.push({ type: 'meeting_upsert', meeting })
    normalizeMeetings(s.workspace.meetings, at)
    const title = meeting.title
    commit(changes, { kind: 'meeting_ended', message: `${title}${iGa(title)} 끝났어요 · 결정 ${decisions}건`, actorId: null })
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
