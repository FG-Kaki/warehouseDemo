// App state + actions. Owned by the architect.
// Entities mirror the DataSource; every mutation goes through an action here
// (optimistic update → DataSource call → reconcile / roll back with a toast).
import { create } from 'zustand'
import { DataError, type DataSource } from './data/DataSource'
import type { Activity, Change, Id, Member, MemberInput, MemberPatch, Project, Reassign, Task, TaskInput, TaskPatch, TaskStatus } from './data/types'
import { EMPTY_FILTERS, type Filters } from './data/selectors'

export type Selection = { kind: 'task'; id: Id } | { kind: 'member'; id: Id }
export type Overlay = 'none' | 'workload' | 'deadline' | 'project'
export type PanelView = 'kanban' | 'list'

export type Dialog =
  | { kind: 'task'; taskId?: Id; defaults?: Partial<TaskInput> }
  | { kind: 'member'; memberId?: Id }
  | { kind: 'removeMember'; memberId: Id }
  | { kind: 'deleteTask'; taskId: Id }
  | { kind: 'confirmReset' }

/** Where a dragged task would land if released now. Set by whoever is under the pointer. */
export type DropTarget = { kind: 'member'; id: Id } | { kind: 'backlog' } | { kind: 'status'; status: TaskStatus }

export interface Toast {
  id: number
  level: 'info' | 'good' | 'warn' | 'bad'
  text: string
}

interface OfficeState {
  // ---- data (mirrors the DataSource) ----
  status: 'idle' | 'loading' | 'ready' | 'error'
  sourceLabel: string
  canDemo: boolean
  canReset: boolean
  projects: Record<Id, Project>
  members: Record<Id, Member>
  tasks: Record<Id, Task>
  /** Newest last, capped at 100. */
  activity: Activity[]

  // ---- view state ----
  selection: Selection | null
  select: (s: Selection | null) => void
  /** Hovered thing in either the 3D view or the panel; both highlight it. */
  hover: Selection | null
  setHover: (s: Selection | null) => void
  filters: Filters
  setFilters: (patch: Partial<Filters>) => void
  clearFilters: () => void
  overlay: Overlay
  setOverlay: (o: Overlay) => void
  panelView: PanelView
  setPanelView: (v: PanelView) => void
  dialog: Dialog | null
  openDialog: (d: Dialog | null) => void
  /** Camera fly-to request. Scene resolves the target's position, then clears it. */
  focus: { target: Selection; key: number } | null
  focusOn: (target: Selection) => void
  clearFocus: () => void
  demoMode: boolean
  setDemoMode: (on: boolean) => void

  // ---- drag & drop (3D ↔ panel) ----
  drag: { taskId: Id; from: 'scene' | 'panel' } | null
  dropTarget: DropTarget | null
  startDrag: (taskId: Id, from: 'scene' | 'panel') => void
  setDropTarget: (t: DropTarget | null) => void
  /** Apply the drop (if any) and clear drag state. Called on pointerup anywhere. */
  endDrag: () => void
  cancelDrag: () => void

  toasts: Toast[]
  toast: (level: Toast['level'], text: string) => void
  dismissToast: (id: number) => void

  /**
   * Screen-space margins (CSS px) covered by HUD panels. The UI reports them; the scene
   * frames the office inside the remaining area (e.g. via camera.setViewOffset).
   */
  viewInsets: { top: number; right: number; bottom: number; left: number }
  setViewInsets: (v: OfficeState['viewInsets']) => void

  // ---- actions ----
  // Mutations resolve to true on success, false on failure (a toast was already shown).
  init: (source: DataSource) => Promise<void>
  createTask: (input: TaskInput) => Promise<Task | null>
  updateTask: (id: Id, patch: TaskPatch) => Promise<boolean>
  deleteTask: (id: Id) => Promise<boolean>
  /** Assign to a member (top of their stack) or null (back to the backlog shelf). */
  assignTask: (taskId: Id, memberId: Id | null) => Promise<boolean>
  moveTask: (taskId: Id, status: TaskStatus) => Promise<boolean>
  createMember: (input: MemberInput) => Promise<Member | null>
  updateMember: (id: Id, patch: MemberPatch) => Promise<boolean>
  deleteMember: (id: Id, reassign: Reassign) => Promise<boolean>
  /** Only available when canReset. */
  resetData: () => Promise<boolean>
}

let source: DataSource | null = null
let unsubscribe: (() => void) | null = null
let toastSeq = 1

const DEMO_PREF_KEY = 'office-dashboard:demo'
const readPref = (k: string) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const writePref = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v)
  } catch {
    // Private mode / blocked storage: the preference just isn't remembered.
  }
}

const byId = <T extends { id: Id }>(list: T[]) => Object.fromEntries(list.map((x) => [x.id, x])) as Record<Id, T>
const isNotFound = (e: unknown) => e instanceof DataError && e.code === 'not_found'
const errText = (e: unknown) => (e instanceof Error && e.message ? e.message : '요청을 처리하지 못했어요')
const without = <T>(rec: Record<Id, T>, id: Id) => {
  const next = { ...rec }
  delete next[id]
  return next
}

export const useOffice = create<OfficeState>((set, get) => {
  const fail = (e: unknown) => get().toast('bad', errText(e))

  const apply = (c: Change) => {
    const s = get()
    switch (c.type) {
      case 'task_upsert':
        set({ tasks: { ...s.tasks, [c.task.id]: c.task } })
        break
      case 'task_delete':
        if (s.tasks[c.id]) set({ tasks: without(s.tasks, c.id) })
        if (s.selection?.kind === 'task' && s.selection.id === c.id) set({ selection: null })
        break
      case 'member_upsert':
        set({ members: { ...s.members, [c.member.id]: c.member } })
        break
      case 'member_delete':
        if (s.members[c.id]) set({ members: without(s.members, c.id) })
        if (s.selection?.kind === 'member' && s.selection.id === c.id) set({ selection: null })
        if (s.filters.assigneeIds.includes(c.id)) {
          set({ filters: { ...s.filters, assigneeIds: s.filters.assigneeIds.filter((x) => x !== c.id) } })
        }
        break
      case 'project_upsert':
        set({ projects: { ...s.projects, [c.project.id]: c.project } })
        break
      case 'activity':
        if (!s.activity.some((a) => a.id === c.activity.id)) set({ activity: [...s.activity, c.activity].slice(-100) })
        break
    }
  }

  return {
    status: 'idle',
    sourceLabel: '',
    canDemo: false,
    canReset: false,
    projects: {},
    members: {},
    tasks: {},
    activity: [],

    selection: null,
    select: (selection) => set({ selection }),
    hover: null,
    setHover: (hover) => {
      const cur = get().hover
      if (cur === hover || (cur && hover && cur.kind === hover.kind && cur.id === hover.id)) return
      set({ hover })
    },
    filters: EMPTY_FILTERS,
    setFilters: (patch) => set({ filters: { ...get().filters, ...patch } }),
    clearFilters: () => set({ filters: EMPTY_FILTERS }),
    overlay: 'none',
    setOverlay: (overlay) => set({ overlay }),
    panelView: 'kanban',
    setPanelView: (panelView) => set({ panelView }),
    dialog: null,
    openDialog: (dialog) => set({ dialog }),
    focus: null,
    focusOn: (target) => set({ focus: { target, key: Date.now() } }),
    clearFocus: () => set({ focus: null }),
    demoMode: false,
    setDemoMode: (on) => {
      const enabled = on && !!source?.setDemoMode
      const busy = get().dialog !== null || get().drag !== null
      source?.setDemoMode?.(enabled && !busy)
      writePref(DEMO_PREF_KEY, enabled ? '1' : '0')
      set({ demoMode: enabled })
    },

    viewInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    setViewInsets: (v) => {
      const cur = get().viewInsets
      if (cur.top === v.top && cur.right === v.right && cur.bottom === v.bottom && cur.left === v.left) return
      set({ viewInsets: v })
    },

    drag: null,
    dropTarget: null,
    startDrag: (taskId, from) => set({ drag: { taskId, from }, dropTarget: null }),
    setDropTarget: (t) => {
      const cur = get().dropTarget
      if (JSON.stringify(cur) === JSON.stringify(t)) return
      set({ dropTarget: t })
    },
    endDrag: () => {
      const { drag, dropTarget } = get()
      set({ drag: null, dropTarget: null })
      if (!drag || !dropTarget) return
      if (dropTarget.kind === 'member') void get().assignTask(drag.taskId, dropTarget.id)
      else if (dropTarget.kind === 'backlog') void get().assignTask(drag.taskId, null)
      else void get().moveTask(drag.taskId, dropTarget.status)
    },
    cancelDrag: () => set({ drag: null, dropTarget: null }),

    toasts: [],
    toast: (level, text) => {
      const id = toastSeq++
      set({ toasts: [...get().toasts.slice(-3), { id, level, text }] })
      setTimeout(() => get().dismissToast(id), 3500)
    },
    dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

    init: async (src) => {
      if (src === source) return
      unsubscribe?.()
      unsubscribe = null
      source?.setDemoMode?.(false)
      source = src
      set({ status: 'loading', sourceLabel: src.label, canDemo: !!src.setDemoMode, canReset: !!src.reset })
      try {
        const ws = await src.load()
        set({
          status: 'ready',
          projects: byId(ws.projects),
          members: byId(ws.members),
          tasks: byId(ws.tasks),
          activity: ws.activity.slice(-100),
        })
        unsubscribe = src.subscribe(apply)
        // Demo teammates start on by default; the toggle is remembered per browser.
        if (src.setDemoMode) get().setDemoMode(readPref(DEMO_PREF_KEY) !== '0')
      } catch (e) {
        set({ status: 'error' })
        fail(e)
      }
    },

    createTask: async (input) => {
      if (!source) return null
      try {
        const task = await source.createTask(input)
        apply({ type: 'task_upsert', task })
        return task
      } catch (e) {
        fail(e)
        return null
      }
    },

    updateTask: async (id, patch) => {
      const prev = get().tasks[id]
      if (!source || !prev) return false
      const optimistic: Task = { ...prev, ...patch, updatedAt: new Date().toISOString() }
      if (patch.status && patch.status !== prev.status) {
        optimistic.completedAt = patch.status === 'done' ? new Date().toISOString() : null
      }
      apply({ type: 'task_upsert', task: optimistic })
      try {
        apply({ type: 'task_upsert', task: await source.updateTask(id, patch) })
        return true
      } catch (e) {
        const cur = get().tasks[id]
        if (isNotFound(e)) {
          apply({ type: 'task_delete', id })
        } else if (cur) {
          // Undo only the fields we changed, and only where nobody changed them since.
          const undo: Partial<Task> = {}
          for (const k of Object.keys(patch) as (keyof TaskPatch)[]) {
            if (cur[k] === optimistic[k]) (undo as Record<string, unknown>)[k] = prev[k]
          }
          if (cur.completedAt === optimistic.completedAt) undo.completedAt = prev.completedAt
          apply({ type: 'task_upsert', task: { ...cur, ...undo } })
        }
        fail(e)
        return false
      }
    },

    deleteTask: async (id) => {
      const prev = get().tasks[id]
      if (!source || !prev) return false
      apply({ type: 'task_delete', id })
      try {
        await source.deleteTask(id)
        return true
      } catch (e) {
        if (!isNotFound(e)) {
          apply({ type: 'task_upsert', task: prev })
          fail(e)
          return false
        }
        return true
      }
    },

    assignTask: async (taskId, memberId) => {
      const { tasks } = get()
      const t = tasks[taskId]
      if (!t) return false
      if (t.assigneeId === memberId) return true
      const top = Math.max(0, ...Object.values(tasks).filter((x) => x.assigneeId === memberId).map((x) => x.order)) + 1
      const patch: TaskPatch = { assigneeId: memberId, order: top }
      if (memberId === null && (t.status === 'in_progress' || t.status === 'review')) patch.status = 'todo'
      return get().updateTask(taskId, patch)
    },

    moveTask: async (taskId, status) => {
      const t = get().tasks[taskId]
      if (!t) return false
      if (t.status === status) return true
      return get().updateTask(taskId, { status })
    },

    createMember: async (input) => {
      if (!source) return null
      try {
        const member = await source.createMember(input)
        apply({ type: 'member_upsert', member })
        return member
      } catch (e) {
        fail(e)
        return null
      }
    },

    updateMember: async (id, patch) => {
      const prev = get().members[id]
      if (!source || !prev) return false
      const optimistic = { ...prev, ...patch }
      apply({ type: 'member_upsert', member: optimistic })
      try {
        apply({ type: 'member_upsert', member: await source.updateMember(id, patch) })
        return true
      } catch (e) {
        if (get().members[id] === optimistic) apply({ type: 'member_upsert', member: prev })
        fail(e)
        return false
      }
    },

    deleteMember: async (id, reassign) => {
      if (!source || !get().members[id]) return false
      try {
        // Not optimistic: the source moves tasks and pushes the resulting changes.
        await source.deleteMember(id, reassign)
        apply({ type: 'member_delete', id })
        return true
      } catch (e) {
        fail(e)
        return false
      }
    },

    resetData: async () => {
      if (!source?.reset) return false
      try {
        const ws = await source.reset()
        set({
          projects: byId(ws.projects),
          members: byId(ws.members),
          tasks: byId(ws.tasks),
          activity: ws.activity.slice(-100),
          selection: null,
          hover: null,
          filters: EMPTY_FILTERS,
          dialog: null,
          drag: null,
          dropTarget: null,
        })
        return true
      } catch (e) {
        fail(e)
        return false
      }
    },
  }
})

// Demo teammates pause while the user is in the middle of something (dialog open or dragging),
// so simulated changes never race a user's edit.
useOffice.subscribe((s, prev) => {
  const busy = s.dialog !== null || s.drag !== null
  const wasBusy = prev.dialog !== null || prev.drag !== null
  if (busy === wasBusy || !s.demoMode) return
  source?.setDemoMode?.(!busy)
})
