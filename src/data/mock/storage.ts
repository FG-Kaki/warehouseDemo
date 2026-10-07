// localStorage persistence for the mock source. Loading repairs what it can field by field and
// only gives up (→ reseed, with a backup of the raw string) when the structure is unusable.
import { ESTIMATES, PRESENCE_META, PRIORITY_META, STATUS_META } from '../meta'
import type { Activity, AgendaOutcome, Meeting, Member, Project, Task, Workspace } from '../types'
import { MAX_MEMBERS, OFFICE, deskById } from '../../office/layout'
import { MAX_ENDED_MEETINGS } from '../rules/meetings'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  /**
   * Optional: notifies when ANOTHER tab/instance writes `key` (the browser `storage` event).
   * Returns an unsubscribe function.
   */
  subscribe?(key: string, cb: (newValue: string | null) => void): () => void
}

export const STORAGE_KEY = 'office-dashboard:v1'
export const CORRUPT_KEY = `${STORAGE_KEY}:corrupt`
/** Manager-touch timestamps + planned member returns, shared between tabs. */
export const META_KEY = `${STORAGE_KEY}:meta`
/** Demo leader lease (heartbeat fallback when Web Locks are unavailable). */
export const LEADER_KEY = `${STORAGE_KEY}:leader`

export interface Persisted {
  version: 1
  workspace: Workspace
  nextNumber: number
}

/**
 * In-memory storage hub. Each `view()` behaves like one browser tab on the same localStorage:
 * a write from one view notifies the subscribers of the OTHER views (like the `storage` event).
 */
export function createSharedMemoryStorage() {
  const map = new Map<string, string>()
  const views = new Set<{ key: string; cb: (v: string | null) => void; owner: object }>()
  return {
    view(): StorageLike {
      const owner = {}
      const notify = (key: string, value: string | null) => {
        for (const s of [...views]) if (s.owner !== owner && s.key === key) s.cb(value)
      }
      return {
        getItem: (k) => map.get(k) ?? null,
        setItem(k, v) {
          map.set(k, v)
          notify(k, v)
        },
        removeItem(k) {
          map.delete(k)
          notify(k, null)
        },
        subscribe(key, cb) {
          const entry = { key, cb, owner }
          views.add(entry)
          return () => void views.delete(entry)
        },
      }
    },
  }
}

export function createMemoryStorage(): StorageLike {
  return createSharedMemoryStorage().view()
}

/** window.localStorage (with `storage` event support) when usable, otherwise in-memory. */
export function defaultStorage(): StorageLike {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const ls = window.localStorage
      const probe = '__office_probe__'
      ls.setItem(probe, '1')
      ls.removeItem(probe)
      return {
        getItem: (k) => ls.getItem(k),
        setItem: (k, v) => ls.setItem(k, v),
        removeItem: (k) => ls.removeItem(k),
        subscribe(key, cb) {
          const handler = (e: StorageEvent) => {
            if (e.storageArea === ls && e.key === key) cb(e.newValue)
          }
          window.addEventListener('storage', handler)
          return () => window.removeEventListener('storage', handler)
        },
      }
    }
  } catch {
    // blocked or unavailable
  }
  return createMemoryStorage()
}

// ---- parsing / repair --------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isDate = (v: unknown): v is string => {
  if (!isStr(v) || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}
const HEX = /^#[0-9a-fA-F]{6}$/

export interface ParseResult {
  state: Persisted
  /** True when something had to be fixed or dropped. */
  repaired: boolean
}

/** Parses + repairs persisted JSON. Returns null when the structure is unusable. */
export function parsePersisted(raw: string, nowIso: string): ParseResult | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObj(data) || data.version !== 1 || !isObj(data.workspace)) return null
  const { projects, members, tasks, activity } = data.workspace
  if (!Array.isArray(projects) || !Array.isArray(members) || !Array.isArray(tasks) || !Array.isArray(activity)) return null

  let repaired = false
  const fix = () => void (repaired = true)

  // projects
  const outProjects: Project[] = []
  const projectIds = new Set<string>()
  for (const p of projects) {
    if (!isObj(p) || !isStr(p.id) || !isStr(p.key) || !isStr(p.name) || projectIds.has(p.id)) {
      fix()
      continue
    }
    if (!isStr(p.color) || !HEX.test(p.color)) fix()
    outProjects.push({ id: p.id, key: p.key, name: p.name, color: isStr(p.color) && HEX.test(p.color) ? p.color : '#6b7a99' })
    projectIds.add(p.id)
  }
  if (outProjects.length === 0) return null

  // members
  const outMembers: Member[] = []
  const memberIds = new Set<string>()
  const usedDesks = new Set<string>()
  const pendingDesk: Member[] = []
  for (const m of members) {
    if (!isObj(m) || !isStr(m.id) || !isStr(m.name) || m.name.trim() === '' || memberIds.has(m.id)) {
      fix()
      continue
    }
    if (outMembers.length + pendingDesk.length >= MAX_MEMBERS) {
      fix()
      continue
    }
    const capacityOk = isNum(m.capacity) && m.capacity >= 1 && m.capacity <= 40
    const presenceOk = isStr(m.presence) && m.presence in PRESENCE_META
    const colorOk = isStr(m.color) && HEX.test(m.color)
    const variantOk = isNum(m.avatarVariant) && Number.isInteger(m.avatarVariant) && m.avatarVariant >= 0
    if (!capacityOk || !presenceOk || !colorOk || !variantOk || !isStr(m.role) || !isStr(m.joinedAt)) fix()
    const member: Member = {
      id: m.id,
      name: m.name,
      role: isStr(m.role) ? m.role : '팀원',
      color: colorOk ? (m.color as string) : '#3a6df0',
      capacity: capacityOk ? (m.capacity as number) : isNum(m.capacity) ? Math.min(40, Math.max(1, Math.round(m.capacity))) : 8,
      deskId: '',
      presence: presenceOk ? (m.presence as Member['presence']) : 'working',
      avatarVariant: variantOk ? (m.avatarVariant as number) : 0,
      joinedAt: isStr(m.joinedAt) ? m.joinedAt : nowIso,
    }
    memberIds.add(member.id)
    if (isStr(m.deskId) && deskById(m.deskId) && !usedDesks.has(m.deskId)) {
      member.deskId = m.deskId
      usedDesks.add(m.deskId)
      outMembers.push(member)
    } else {
      fix()
      pendingDesk.push(member)
    }
  }
  for (const member of pendingDesk) {
    const free = OFFICE.desks.find((d) => !usedDesks.has(d.id))
    if (!free) continue
    member.deskId = free.id
    usedDesks.add(free.id)
    outMembers.push(member)
  }
  const keptMemberIds = new Set(outMembers.map((m) => m.id))

  // tasks
  const outTasks: Task[] = []
  const taskIds = new Set<string>()
  const numbers = new Set<number>()
  const needNumber: Task[] = []
  let maxNumber = 0
  tasks.forEach((t, index) => {
    if (!isObj(t) || !isStr(t.id) || !isStr(t.title) || t.title.trim() === '' || taskIds.has(t.id) || !isStr(t.projectId) || !projectIds.has(t.projectId)) {
      fix()
      return
    }
    const statusOk = isStr(t.status) && t.status in STATUS_META
    const priorityOk = isStr(t.priority) && t.priority in PRIORITY_META
    const estimateOk = ESTIMATES.includes(t.estimate as never)
    const dueOk = t.dueDate === null || isDate(t.dueDate)
    const assigneeOk = t.assigneeId === null || (isStr(t.assigneeId) && keptMemberIds.has(t.assigneeId))
    const status = (statusOk ? t.status : 'todo') as Task['status']
    const createdAt = isStr(t.createdAt) ? t.createdAt : nowIso
    const updatedAt = isStr(t.updatedAt) ? t.updatedAt : createdAt
    const completedAt = status === 'done' ? (isStr(t.completedAt) ? t.completedAt : updatedAt) : null
    if (!statusOk || !priorityOk || !estimateOk || !dueOk || !assigneeOk || !isStr(t.description) || !isNum(t.order) || !isStr(t.createdAt) || !isStr(t.updatedAt)) fix()
    if ((t.status === 'done') !== isStr(t.completedAt)) fix()
    // Old data has no onAgenda: that is not damage. Anything else wrong with it is repaired (and reported).
    if (t.onAgenda !== undefined && typeof t.onAgenda !== 'boolean') fix()
    const onAgenda = t.onAgenda === true && status !== 'done'
    if (t.onAgenda === true && status === 'done') fix()
    const task: Task = {
      id: t.id,
      number: isNum(t.number) && Number.isInteger(t.number) && t.number > 0 ? t.number : -1,
      title: t.title,
      description: isStr(t.description) ? t.description : '',
      status,
      priority: (priorityOk ? t.priority : 'medium') as Task['priority'],
      estimate: (estimateOk ? t.estimate : 3) as Task['estimate'],
      projectId: t.projectId,
      assigneeId: assigneeOk ? (t.assigneeId as string | null) : null,
      dueDate: dueOk ? (t.dueDate as string | null) : null,
      order: isNum(t.order) ? t.order : index + 1,
      createdAt,
      updatedAt,
      completedAt,
      onAgenda,
    }
    taskIds.add(task.id)
    if (task.number < 0 || numbers.has(task.number)) {
      fix()
      needNumber.push(task)
    } else {
      numbers.add(task.number)
      maxNumber = Math.max(maxNumber, task.number)
    }
    outTasks.push(task)
  })
  let nextNumber = Math.max(isNum(data.nextNumber) ? Math.floor(data.nextNumber) : 1, maxNumber + 1)
  if (!isNum(data.nextNumber) || data.nextNumber <= maxNumber) fix()
  for (const task of needNumber) task.number = nextNumber++

  // activity
  const outActivity: Activity[] = []
  const activityIds = new Set<string>()
  for (const a of activity) {
    if (!isObj(a) || !isStr(a.id) || !isStr(a.at) || !isStr(a.kind) || !isStr(a.message) || activityIds.has(a.id)) {
      fix()
      continue
    }
    if (a.actorId !== null && !isStr(a.actorId)) fix()
    activityIds.add(a.id)
    const entry: Activity = { id: a.id, at: a.at, kind: a.kind as Activity['kind'], actorId: isStr(a.actorId) ? a.actorId : null, message: a.message }
    if (isStr(a.taskId)) entry.taskId = a.taskId
    if (isStr(a.memberId)) entry.memberId = a.memberId
    outActivity.push(entry)
  }
  if (outActivity.length > 100) {
    fix()
    outActivity.splice(0, outActivity.length - 100)
  }

  // meetings (optional: data saved before meetings existed has none)
  const outMeetings: Meeting[] = []
  if (data.workspace.meetings !== undefined && !Array.isArray(data.workspace.meetings)) fix()
  if (Array.isArray(data.workspace.meetings)) {
    const meetingIds = new Set<string>()
    for (const raw of data.workspace.meetings) {
      const meeting = parseMeeting(raw, keptMemberIds, taskIds, nowIso)
      if (!meeting || meetingIds.has(meeting.meeting.id)) {
        fix()
        continue
      }
      if (meeting.repaired) fix()
      meetingIds.add(meeting.meeting.id)
      outMeetings.push(meeting.meeting)
    }
  }
  if (normalizeMeetings(outMeetings, nowIso)) fix()

  return {
    state: { version: 1, workspace: { projects: outProjects, members: outMembers, tasks: outTasks, meetings: outMeetings, activity: outActivity }, nextNumber },
    repaired,
  }
}


/**
 * Keeps at most one ongoing meeting (the one started first; the others are closed), sorts oldest first and
 * trims the ended ones to the most recent MAX_ENDED_MEETINGS. Returns true when it had to change anything.
 */
export function normalizeMeetings(meetings: Meeting[], nowIso: string): boolean {
  let changed = false
  const ongoing = meetings.filter((m) => m.status === 'ongoing').sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  for (const extra of ongoing.slice(1)) {
    extra.status = 'ended'
    extra.endedAt = nowIso
    changed = true
  }
  const sorted = [...meetings].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const ended = sorted.filter((m) => m.status === 'ended')
  const drop = new Set(ended.slice(0, Math.max(0, ended.length - MAX_ENDED_MEETINGS)))
  const kept = sorted.filter((m) => !drop.has(m))
  if (drop.size > 0) changed = true
  if (changed || kept.some((m, i) => m !== meetings[i])) {
    meetings.splice(0, meetings.length, ...kept)
  }
  return changed
}

function parseOutcome(o: unknown): AgendaOutcome | null {
  if (!isObj(o) || !isStr(o.taskId)) return null
  if (o.action === 'keep' || o.action === 'backlog') return { taskId: o.taskId, action: o.action }
  if (o.action === 'assign' && isStr(o.memberId)) return { taskId: o.taskId, action: 'assign', memberId: o.memberId }
  if (o.action === 'status' && isStr(o.status) && o.status in STATUS_META) return { taskId: o.taskId, action: 'status', status: o.status as Task['status'] }
  return null
}

function parseMeeting(m: unknown, memberIds: Set<string>, taskIds: Set<string>, nowIso: string): { meeting: Meeting; repaired: boolean } | null {
  if (!isObj(m) || !isStr(m.id) || !isStr(m.title) || !isStr(m.startedAt)) return null
  if (m.status !== 'ongoing' && m.status !== 'ended') return null
  let repaired = false
  const strings = (v: unknown): string[] => {
    if (!Array.isArray(v)) {
      repaired = true
      return []
    }
    const out = v.filter(isStr)
    if (out.length !== v.length) repaired = true
    return [...new Set(out)]
  }
  let attendeeIds = strings(m.attendeeIds)
  let agendaTaskIds = strings(m.agendaTaskIds)
  if (m.status === 'ongoing') {
    // an ongoing meeting only refers to people / tasks that still exist (history keeps whatever it had)
    const a = attendeeIds.filter((id) => memberIds.has(id))
    const t = agendaTaskIds.filter((id) => taskIds.has(id))
    if (a.length !== attendeeIds.length || t.length !== agendaTaskIds.length) repaired = true
    attendeeIds = a
    agendaTaskIds = t
  }
  const outcomes: AgendaOutcome[] = []
  if (Array.isArray(m.outcomes)) {
    for (const raw of m.outcomes) {
      const o = parseOutcome(raw)
      if (o) outcomes.push(o)
      else repaired = true
    }
  } else repaired = true
  if (!isStr(m.notes)) repaired = true
  const ended = m.status === 'ended'
  if (ended && !isStr(m.endedAt)) repaired = true
  return {
    meeting: {
      id: m.id,
      title: m.title,
      attendeeIds,
      agendaTaskIds,
      status: m.status,
      startedAt: m.startedAt,
      endedAt: ended ? (isStr(m.endedAt) ? m.endedAt : nowIso) : null,
      notes: isStr(m.notes) ? m.notes : '',
      outcomes,
    },
    repaired,
  }
}

export type LoadResult =
  | { kind: 'missing' }
  | { kind: 'ok'; state: Persisted; repaired: boolean; raw: string }
  | { kind: 'corrupt'; raw: string }

export function loadPersisted(storage: StorageLike, nowIso: string): LoadResult {
  let raw: string | null
  try {
    raw = storage.getItem(STORAGE_KEY)
  } catch {
    return { kind: 'missing' }
  }
  if (raw === null || raw === '') return { kind: 'missing' }
  const parsed = parsePersisted(raw, nowIso)
  if (!parsed) return { kind: 'corrupt', raw }
  return { kind: 'ok', state: parsed.state, repaired: parsed.repaired, raw }
}

export function backupCorrupt(storage: StorageLike, raw: string): void {
  try {
    storage.setItem(CORRUPT_KEY, raw)
  } catch {
    // best effort
  }
}

export function savePersisted(storage: StorageLike, state: Persisted): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // quota exceeded / storage blocked: keep running in memory
  }
}
