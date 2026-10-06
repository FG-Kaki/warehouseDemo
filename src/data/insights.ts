// Manager insights: member status signal (the Sims-style diamond), "needs" gauges, and
// suggested actions. Pure functions shared by scene/ and ui/. Owned by the architect.
import type { Id, Member, Task } from './types'
import { PRIORITY_META } from './meta'
import { daysUntilDue, isOpen, isOverdue, openPoints, tasksOf, todayIso, workload } from './selectors'

// ---- Status signal (diamond above the avatar) -------------------------------

export type SignalLevel = 'ok' | 'busy' | 'alert'

export const SIGNAL_META: Record<SignalLevel, { label: string; color: string }> = {
  ok: { label: '여유', color: '#22b07d' },
  busy: { label: '바쁨', color: '#f0a020' },
  alert: { label: '주의', color: '#e5484d' },
}

export interface MemberSignal {
  level: SignalLevel
  /** Korean, most important first, e.g. ["지연 1건", "업무량 140%"]. Empty when ok. */
  reasons: string[]
}

export function memberSignal(member: Member, tasks: Record<Id, Task>, today = todayIso()): MemberSignal {
  const mine = tasksOf(tasks, member.id)
  const w = workload(member, tasks)
  const overdue = mine.filter((t) => isOverdue(t, today)).length
  const dueSoon = mine.filter((t) => {
    const d = daysUntilDue(t, today)
    return d !== null && d >= 0 && d <= 2
  }).length
  const pct = `${Math.round(w * 100)}%`
  const reasons: string[] = []
  let level: SignalLevel = 'ok'
  if (overdue > 0) reasons.push(`지연 ${overdue}건`)
  if (w > 1.3) reasons.push(`업무량 ${pct}`)
  if (reasons.length) level = 'alert'
  else {
    if (w > 1.0) reasons.push(`업무량 ${pct}`)
    if (dueSoon > 0) reasons.push(`마감 임박 ${dueSoon}건`)
    if (reasons.length) level = 'busy'
  }
  return { level, reasons }
}

// ---- Needs gauges (the Sims-style status card) ------------------------------

export interface MemberVitals {
  /** open points / capacity, 0..∞ (display capped at 150%). */
  workload: number
  /** 0 (relaxed) .. 1 (something overdue). */
  deadlinePressure: number
  /** 1 = exactly one task in progress; lower when idle or juggling several. */
  focus: number
  openPoints: number
  inProgress: number
}

export function memberVitals(member: Member, tasks: Record<Id, Task>, today = todayIso()): MemberVitals {
  const mine = tasksOf(tasks, member.id)
  let pressure = 0
  for (const t of mine) {
    const d = daysUntilDue(t, today)
    if (d === null) continue
    const p = d < 0 ? 1 : d === 0 ? 0.85 : d <= 2 ? 0.6 : d <= 5 ? 0.3 : 0.1
    if (p > pressure) pressure = p
  }
  const inProgress = mine.filter((t) => t.status === 'in_progress').length
  const focus = inProgress === 0 ? 0.35 : inProgress === 1 ? 1 : Math.max(0.15, 1 - 0.3 * (inProgress - 1))
  return { workload: workload(member, tasks), deadlinePressure: pressure, focus, openPoints: openPoints(mine), inProgress }
}

// ---- Suggested actions --------------------------------------------------------

export type Suggestion =
  | { id: string; kind: 'reassign'; taskId: Id; fromId: Id; toId: Id; title: string; detail: string }
  | { id: string; kind: 'assign'; taskId: Id; toId: Id; title: string; detail: string }

const OVERLOAD = 1.15
const TARGET_MAX = 0.9

/**
 * Up to `limit` one-click suggestions, most valuable first. Deterministic for the same input.
 * `id` is stable per (kind, task[, from]) — not per target — so a dismissal sticks even when the
 * suggested recipient changes as loads shift.
 */
export function suggestActions(
  tasks: Record<Id, Task>,
  members: Record<Id, Member>,
  limit = 3,
  today = todayIso(),
): Suggestion[] {
  const people = Object.values(members).filter((m) => m.capacity > 0)
  if (people.length < 2) return []
  // Working copy of open points so several suggestions don't all dump on the same person.
  const load = new Map(people.map((m) => [m.id, openPoints(tasksOf(tasks, m.id))]))
  const ratio = (id: Id) => (load.get(id) ?? 0) / (members[id]?.capacity || 1)
  const lightest = (exclude: Id | null, est: number) =>
    people
      .filter((m) => m.id !== exclude && m.presence !== 'away' && ((load.get(m.id) ?? 0) + est) / m.capacity <= TARGET_MAX)
      .sort((a, b) => ratio(a.id) - ratio(b.id) || a.name.localeCompare(b.name))[0]
  const out: Suggestion[] = []
  const used = new Set<Id>()
  const pct = (id: Id) => `${Math.round(ratio(id) * 100)}%`

  // 1. Rebalance overloaded people: move a not-yet-started task to the lightest teammate.
  const overloaded = people.filter((m) => ratio(m.id) > OVERLOAD).sort((a, b) => ratio(b.id) - ratio(a.id))
  for (const m of overloaded) {
    const movable = tasksOf(tasks, m.id)
      .filter((t) => t.status === 'todo' && !used.has(t.id))
      // Most urgent first: an overdue/at-risk task benefits most from a fresh pair of hands.
      .sort((a, b) => urgency(b, today) - urgency(a, today) || b.estimate - a.estimate)
    for (const t of movable) {
      const to = lightest(m.id, t.estimate)
      // Too big for anyone right now — a smaller task of theirs may still fit.
      if (!to) continue
      out.push({
        id: `reassign:${t.id}:${m.id}`,
        kind: 'reassign',
        taskId: t.id,
        fromId: m.id,
        toId: to.id,
        title: `${m.name} 님 업무량 ${pct(m.id)}`,
        detail: `'${t.title}' 작업을 ${to.name} 님(${pct(to.id)})에게 넘기면 균형이 맞아요`,
      })
      used.add(t.id)
      load.set(m.id, (load.get(m.id) ?? 0) - t.estimate)
      load.set(to.id, (load.get(to.id) ?? 0) + t.estimate)
      break
    }
  }

  // 2. Important or overdue work sitting in the backlog → assign to the lightest person.
  const waiting = Object.values(tasks)
    .filter((t) => t.assigneeId === null && isOpen(t) && !used.has(t.id))
    .filter((t) => t.priority === 'urgent' || t.priority === 'high' || isOverdue(t, today))
    .sort((a, b) => urgency(b, today) - urgency(a, today) || a.number - b.number)
  for (const t of waiting) {
    const to = lightest(null, t.estimate)
    if (!to) continue
    out.push({
      id: `assign:${t.id}`,
      kind: 'assign',
      taskId: t.id,
      toId: to.id,
      title: isOverdue(t, today) ? '지연된 미배정 작업' : `${PRIORITY_META[t.priority].label} 작업이 대기 중`,
      detail: `'${t.title}' 작업을 ${to.name} 님(${pct(to.id)})에게 배정할까요?`,
    })
    used.add(t.id)
    load.set(to.id, (load.get(to.id) ?? 0) + t.estimate)
  }

  return out.slice(0, limit)
}

function urgency(t: Task, today: string): number {
  const d = daysUntilDue(t, today)
  const due = d === null ? 0 : d < 0 ? 4 : d <= 2 ? 2 : d <= 5 ? 1 : 0
  return due * 10 + PRIORITY_META[t.priority].weight
}
