// Pure derived-data helpers shared by scene/ and ui/. Owned by the architect.
import type { Id, Member, Task } from './types'
import { PRIORITY_META, WORKLOAD_LEVELS } from './meta'

export interface Filters {
  text: string
  projectIds: Id[]
  /** Member ids; the literal 'unassigned' matches tasks without an assignee. */
  assigneeIds: (Id | 'unassigned')[]
  statuses: Task['status'][]
  priorities: Task['priority'][]
  overdueOnly: boolean
}

export const EMPTY_FILTERS: Filters = {
  text: '',
  projectIds: [],
  assigneeIds: [],
  statuses: [],
  priorities: [],
  overdueOnly: false,
}

export function hasActiveFilters(f: Filters): boolean {
  return (
    f.text.trim() !== '' ||
    f.projectIds.length > 0 ||
    f.assigneeIds.length > 0 ||
    f.statuses.length > 0 ||
    f.priorities.length > 0 ||
    f.overdueOnly
  )
}

/** Local YYYY-MM-DD for "today". */
export function todayIso(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function isOpen(t: Task): boolean {
  return t.status !== 'done'
}

export function isOverdue(t: Task, today = todayIso()): boolean {
  return isOpen(t) && t.dueDate !== null && t.dueDate < today
}

/** Days until due (negative = overdue), or null without a due date. */
export function daysUntilDue(t: Task, today = todayIso()): number | null {
  if (!t.dueDate) return null
  const ms = Date.parse(t.dueDate) - Date.parse(today)
  return Math.round(ms / 86_400_000)
}

/** 0 (relaxed) .. 1 (overdue) — for the deadline-risk overlay and box glow. */
export function deadlineRisk(t: Task, today = todayIso()): number {
  if (!isOpen(t)) return 0
  const d = daysUntilDue(t, today)
  if (d === null) return 0
  if (d < 0) return 1
  if (d === 0) return 0.85
  if (d <= 2) return 0.6
  if (d <= 5) return 0.3
  return 0.1
}

export function matchesFilters(t: Task, f: Filters, today = todayIso()): boolean {
  const q = f.text.trim().toLowerCase()
  if (q && !t.title.toLowerCase().includes(q) && !t.description.toLowerCase().includes(q) && !String(t.number).includes(q)) return false
  if (f.projectIds.length && !f.projectIds.includes(t.projectId)) return false
  if (f.assigneeIds.length && !f.assigneeIds.includes(t.assigneeId ?? 'unassigned')) return false
  if (f.statuses.length && !f.statuses.includes(t.status)) return false
  if (f.priorities.length && !f.priorities.includes(t.priority)) return false
  if (f.overdueOnly && !isOverdue(t, today)) return false
  return true
}

/** Open tasks assigned to a member, in stack order (bottom first). */
export function tasksOf(tasks: Record<Id, Task>, memberId: Id): Task[] {
  return Object.values(tasks)
    .filter((t) => t.assigneeId === memberId && isOpen(t))
    .sort((a, b) => a.order - b.order)
}

/** Unassigned open tasks, most important first. */
export function backlogTasks(tasks: Record<Id, Task>): Task[] {
  return Object.values(tasks)
    .filter((t) => t.assigneeId === null && isOpen(t))
    .sort((a, b) => PRIORITY_META[b.priority].weight - PRIORITY_META[a.priority].weight || a.order - b.order)
}

export function openPoints(tasks: Task[]): number {
  return tasks.reduce((s, t) => s + (isOpen(t) ? t.estimate : 0), 0)
}

/** open points / capacity (0 when capacity is 0 and nothing is open). */
export function workload(member: Member, tasks: Record<Id, Task>): number {
  const pts = openPoints(tasksOf(tasks, member.id))
  if (member.capacity <= 0) return pts > 0 ? 2 : 0
  return pts / member.capacity
}

export function workloadLevel(ratio: number) {
  return WORKLOAD_LEVELS.find((l) => ratio <= l.max) ?? WORKLOAD_LEVELS[WORKLOAD_LEVELS.length - 1]
}

export interface Kpis {
  open: number
  inProgress: number
  overdue: number
  unassigned: number
  doneThisWeek: number
  /** Coefficient of variation of member workloads, 0 = perfectly balanced. */
  imbalance: number
  /** Member id with the highest workload, if any. */
  busiestId: Id | null
}

/** Monday 00:00 local of the current week, ISO. */
export function weekStartIso(now = new Date()): string {
  const d = new Date(now)
  const day = (d.getDay() + 6) % 7
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - day)
  return d.toISOString()
}

export function computeKpis(tasks: Record<Id, Task>, members: Record<Id, Member>, now = new Date()): Kpis {
  const today = todayIso(now)
  const weekStart = weekStartIso(now)
  let open = 0, inProgress = 0, overdue = 0, unassigned = 0, doneThisWeek = 0
  for (const t of Object.values(tasks)) {
    if (isOpen(t)) {
      open++
      if (t.status === 'in_progress') inProgress++
      if (isOverdue(t, today)) overdue++
      if (t.assigneeId === null) unassigned++
    } else if (t.completedAt && t.completedAt >= weekStart) {
      doneThisWeek++
    }
  }
  const loads = Object.values(members).map((m) => ({ id: m.id, w: workload(m, tasks) }))
  let imbalance = 0
  let busiestId: Id | null = null
  if (loads.length > 0) {
    const mean = loads.reduce((s, l) => s + l.w, 0) / loads.length
    const variance = loads.reduce((s, l) => s + (l.w - mean) ** 2, 0) / loads.length
    imbalance = mean > 0 ? Math.sqrt(variance) / mean : 0
    busiestId = loads.reduce((a, b) => (b.w > a.w ? b : a)).id
  }
  return { open, inProgress, overdue, unassigned, doneThisWeek, imbalance, busiestId }
}

export function taskKey(t: Task, projectKey: string | undefined): string {
  return `${projectKey ?? 'T'}-${t.number}`
}
