// Where every task box wants to be: desk stack, backlog shelf or done shelf.
import { backlogTasks, isOpen, tasksOf, workload } from '../data/selectors'
import type { Id, Member, Task } from '../data/types'
import { deskById, OFFICE } from '../office/layout'
import { BACKLOG_CENTER_X, BACKLOG_LEVELS, DONE_TOP } from './Furniture'
import { DESK_TOP_Y, deskLocalToWorld } from './Desks'

export const BOX_W = 0.42
export const BOX_D = 0.34
export const DONE_SLOTS = 16

export const boxHeight = (estimate: number) => 0.14 + estimate * 0.06

export interface Slot {
  x: number
  y: number
  z: number
  rot: number
  scale: number
  /** 0 = steady, 1 = gently wobbling (overloaded owner's stack). */
  wobble: number
  home: 'desk' | 'backlog' | 'done'
}

function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return ((h >>> 0) % 10000) / 10000
}

const tmp = { x: 0, z: 0 }
const STACK_COLS = [
  { lx: 0.69, lz: 0.25 },
  { lx: 0.69, lz: -0.23 },
]
const COL_CAP = 5

function sameSlot(a: Slot, b: Slot) {
  return (
    Math.abs(a.x - b.x) < 1e-4 &&
    Math.abs(a.y - b.y) < 1e-4 &&
    Math.abs(a.z - b.z) < 1e-4 &&
    Math.abs(a.rot - b.rot) < 1e-4 &&
    a.scale === b.scale &&
    a.wobble === b.wobble &&
    a.home === b.home
  )
}

/**
 * Compute a slot for every visible task. `doneAssign` persists which done-shelf cell each completed task
 * occupies so older trophies don't shuffle when a new one arrives. `prev` keeps slot object identity stable.
 */
export function computeSlots(
  tasks: Record<Id, Task>,
  members: Record<Id, Member>,
  doneAssign: Map<Id, number>,
  prev: Map<Id, Slot>,
): Map<Id, Slot> {
  const out = new Map<Id, Slot>()
  const put = (id: Id, s: Slot) => {
    const old = prev.get(id)
    out.set(id, old && sameSlot(old, s) ? old : s)
  }

  // ---- desk stacks ----
  const orphans: Task[] = []
  for (const m of Object.values(members)) {
    const desk = deskById(m.deskId)
    if (!desk) continue
    const list = tasksOf(tasks, m.id)
    const inProg = list.find((t) => t.status === 'in_progress')
    const rest = inProg ? list.filter((t) => t !== inProg) : list
    const wobble = workload(m, tasks) > 1.3 ? 1 : 0

    if (inProg) {
      deskLocalToWorld(desk, 0.2, -0.02, tmp)
      put(inProg.id, { x: tmp.x, y: DESK_TOP_Y, z: tmp.z, rot: desk.facing + (hash01(inProg.id) - 0.5) * 0.3, scale: 1, wobble: 0, home: 'desk' })
    }
    const heights = [DESK_TOP_Y, DESK_TOP_Y]
    rest.forEach((t, i) => {
      const col = i < COL_CAP ? 0 : i < COL_CAP * 2 ? 1 : i % 2
      const c = STACK_COLS[col]
      const j = hash01(t.id)
      deskLocalToWorld(desk, c.lx + (j - 0.5) * 0.05, c.lz + (hash01(t.id + 'z') - 0.5) * 0.05, tmp)
      put(t.id, { x: tmp.x, y: heights[col], z: tmp.z, rot: desk.facing + (j - 0.5) * 0.28, scale: 1, wobble, home: 'desk' })
      heights[col] += boxHeight(t.estimate) + 0.012
    })
  }

  // Open tasks whose owner (or owner's desk) is missing wait on the backlog shelf.
  for (const t of Object.values(tasks)) {
    if (!isOpen(t) || t.assigneeId === null) continue
    const m = members[t.assigneeId]
    if (!m || !deskById(m.deskId)) orphans.push(t)
  }

  // ---- backlog shelf ----
  const A = OFFICE.backlogShelf
  const shelf = [...backlogTasks(tasks), ...orphans]
  const levels = BACKLOG_LEVELS.length
  const cols = 10
  const pitch = 0.56
  const z0 = A.z + (A.d - (cols - 1) * pitch) / 2
  shelf.forEach((t, i) => {
    let level = i % levels
    let col = Math.floor(i / levels)
    let y = BACKLOG_LEVELS[level]
    if (col >= cols) {
      const extra = i - cols * levels
      level = levels - 1
      col = extra % cols
      y = BACKLOG_LEVELS[level] + 0.75 + Math.floor(extra / cols) * 0.5
    }
    put(t.id, { x: BACKLOG_CENTER_X, y, z: z0 + col * pitch, rot: Math.PI / 2 + (hash01(t.id) - 0.5) * 0.12, scale: 0.92, wobble: 0, home: 'backlog' })
  })

  // ---- done shelf ----
  const D = OFFICE.doneShelf
  const recent = Object.values(tasks)
    .filter((t) => t.status === 'done' && t.completedAt)
    .sort((a, b) => (b.completedAt! < a.completedAt! ? -1 : b.completedAt! > a.completedAt! ? 1 : 0))
    .slice(0, DONE_SLOTS)
  const keep = new Set(recent.map((t) => t.id))
  for (const id of [...doneAssign.keys()]) if (!keep.has(id)) doneAssign.delete(id)
  const used = new Set(doneAssign.values())
  for (const t of recent) {
    if (doneAssign.has(t.id)) continue
    let k = 0
    while (used.has(k)) k++
    doneAssign.set(t.id, k)
    used.add(k)
  }
  const perRow = DONE_SLOTS / 2
  const step = (D.w - 1) / (perRow - 1)
  for (const t of recent) {
    const k = doneAssign.get(t.id) ?? 0
    const col = k % perRow
    const row = Math.floor(k / perRow)
    put(t.id, {
      x: D.x + 0.5 + col * step,
      y: DONE_TOP,
      z: D.z + (row === 0 ? 0.58 : 0.22),
      rot: (hash01(t.id) - 0.5) * 0.5,
      scale: 0.6,
      wobble: 0,
      home: 'done',
    })
  }
  return out
}
