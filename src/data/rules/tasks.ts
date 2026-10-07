// Pure task rules shared by the mock source and the server: stack ordering, status / completedAt,
// agenda clearing, and what happens to a leaving member's tasks. No I/O: callers apply the results.
import { DataError } from '../DataSource'
import type { Id, Reassign, Task } from '../types'

/** Order value that puts a task on top of an assignee's stack (null = the backlog). */
export function topOrder(tasks: readonly Task[], assigneeId: Id | null): number {
  let max = 0
  for (const t of tasks) if (t.assigneeId === assigneeId && t.order > max) max = t.order
  return max + 1
}

export interface PatchContext {
  /** ISO timestamp of the change. */
  at: string
  /** Top-of-stack order for an assignee, evaluated against the current data. */
  topOrder(assigneeId: Id | null): number
}

export interface PatchResult {
  /** The task after the patch (a copy; `updatedAt` is bumped only when something changed). */
  next: Task
  /** Keys whose value differs from `task`. Empty = a no-op: write and emit nothing. */
  changed: (keyof Task)[]
}

/**
 * Applies a validated patch: moves to the top of the new stack when the assignee changes (unless an
 * explicit order is given), sets / clears `completedAt` with the status, keeps done tasks off the
 * agenda (completing clears the flag; asking for it on a done task is a 400).
 */
export function applyTaskPatch(task: Task, patch: Partial<Task>, ctx: PatchContext): PatchResult {
  const next: Partial<Task> = { ...patch }
  if ((next.status ?? task.status) === 'done') {
    if (next.onAgenda === true) throw new DataError('완료된 작업은 안건으로 올릴 수 없어요')
    if (task.onAgenda) next.onAgenda = false
  }
  if (next.assigneeId !== undefined && next.assigneeId !== task.assigneeId && next.order === undefined) {
    next.order = ctx.topOrder(next.assigneeId)
  }
  if (next.status !== undefined && next.status !== task.status) {
    next.completedAt = next.status === 'done' ? ctx.at : null
  }
  const changed = (Object.keys(next) as (keyof Task)[]).filter((k) => next[k] !== task[k])
  if (changed.length === 0) return { next: { ...task }, changed }
  return { next: { ...task, ...next, updatedAt: ctx.at }, changed }
}

/** Unassigned, on top of the backlog; work in flight goes back to todo. Mutates the (working) copy. */
export function sendToBacklog(task: Task, ctx: Pick<PatchContext, 'topOrder'>): void {
  if (task.assigneeId !== null) {
    task.assigneeId = null
    task.order = ctx.topOrder(null)
  }
  if (task.status === 'in_progress' || task.status === 'review') task.status = 'todo'
}

export interface MemberRemovalPlan {
  /** Every task that changed (the member's tasks), as new copies, in the order they were moved. */
  tasks: Task[]
  /** Open tasks that moved to somebody / the backlog (done tasks only lose their assignee). */
  movedOpen: number
}

/**
 * What happens to `memberId`'s tasks when they leave: open tasks go to the target member (statuses
 * kept) or back to the backlog (in_progress / review -> todo), each on top of its new stack in the
 * member's own stack order; done tasks just lose the assignee.
 */
export function planMemberRemoval(memberId: Id, allTasks: readonly Task[], reassign: Reassign, at: string): MemberRemovalPlan {
  const working = allTasks.map((t) => ({ ...t }))
  const ctx = { topOrder: (assigneeId: Id | null) => topOrder(working, assigneeId) }
  const theirs = working.filter((t) => t.assigneeId === memberId).sort((a, b) => a.order - b.order)
  let movedOpen = 0
  for (const task of theirs) {
    if (task.status === 'done') {
      task.assigneeId = null
    } else if (reassign.mode === 'member') {
      task.assigneeId = reassign.memberId
      task.order = ctx.topOrder(reassign.memberId)
      movedOpen++
    } else {
      task.assigneeId = null
      task.order = ctx.topOrder(null)
      if (task.status === 'in_progress' || task.status === 'review') task.status = 'todo'
      movedOpen++
    }
    task.updatedAt = at
  }
  return { tasks: theirs, movedOpen }
}
