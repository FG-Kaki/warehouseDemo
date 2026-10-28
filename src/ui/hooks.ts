// Shared hooks for the HUD. OWNER: ui-builder.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Id, Member, Task } from '../data/types'
import { PRIORITY_META } from '../data/meta'
import { isOpen, matchesFilters, todayIso, workload, workloadLevel, tasksOf, openPoints } from '../data/selectors'
import { useOffice } from '../store'

/** Re-renders every `ms` so relative times stay fresh. Returns Date.now(). */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

/** Tasks that pass the store filters. */
export function useFilteredTasks(): Task[] {
  const tasks = useOffice((s) => s.tasks)
  const filters = useOffice((s) => s.filters)
  return useMemo(() => {
    const today = todayIso()
    return Object.values(tasks).filter((t) => matchesFilters(t, filters, today))
  }, [tasks, filters])
}

export function useProjectList() {
  const projects = useOffice((s) => s.projects)
  return useMemo(() => Object.values(projects), [projects])
}

export function useMemberList(): Member[] {
  const members = useOffice((s) => s.members)
  return useMemo(() => Object.values(members).sort((a, b) => a.name.localeCompare(b.name, 'ko')), [members])
}

export interface MemberStat {
  points: number
  count: number
  ratio: number
  level: ReturnType<typeof workloadLevel>
}

export function useMemberStats(): Record<Id, MemberStat> {
  const tasks = useOffice((s) => s.tasks)
  const members = useOffice((s) => s.members)
  return useMemo(() => {
    const out: Record<Id, MemberStat> = {}
    for (const m of Object.values(members)) {
      const mine = tasksOf(tasks, m.id)
      const ratio = workload(m, tasks)
      out[m.id] = { points: openPoints(mine), count: mine.length, ratio, level: workloadLevel(ratio) }
    }
    return out
  }, [tasks, members])
}

/** Below this width the management rail is an overlay drawer instead of a docked column. */
export const OVERLAY_QUERY = '(max-width: 1100px)'

/** Live `matchMedia(query).matches`. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const mq = window.matchMedia(query)
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  )
}

/**
 * One permanent non-passive touchmove listener: WebKit decides scroll-blocking at touchstart, so it has
 * to exist before the finger lands. It only cancels the scroll while a drag is active.
 */
export function useTouchDragGuard() {
  useEffect(() => {
    const block = (ev: TouchEvent) => {
      if (ev.cancelable && useOffice.getState().drag) ev.preventDefault()
    }
    window.addEventListener('touchmove', block, { passive: false })
    return () => window.removeEventListener('touchmove', block)
  }, [])
}

const LONG_PRESS_MS = 300
const TOUCH_SLOP = 8

/**
 * Starts a panel drag (store.startDrag) from a card.
 * - Mouse / pen: pointer-down + move > 4px.
 * - Touch: only after a ~300 ms press without moving (a quick swipe scrolls the list). The card gets
 *   `is-pressing` meanwhile for a small lift, and releases pointer capture once the drag starts so the
 *   elements / 3D view under the finger see the moves.
 * `consumeClick()` returns true (once) if the gesture was a drag, so onClick can skip selecting.
 */
export function useTaskDrag(taskId: Id) {
  const moved = useRef(false)
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return
      moved.current = false
      const sx = e.clientX
      const sy = e.clientY
      const id = e.pointerId
      const el = e.currentTarget as HTMLElement
      // Touch pointers are implicitly captured by the element actually hit (often a child of the card).
      const hit = e.target as Element
      const touch = e.pointerType === 'touch'
      let timer = 0
      let started = false

      const noMenu = (ev: Event) => ev.preventDefault()
      const begin = () => {
        if (started) return
        started = true
        moved.current = true
        el.classList.remove('is-pressing')
        useOffice.getState().startDrag(taskId, 'panel')
        if (touch) {
          try {
            if (hit.hasPointerCapture?.(id)) hit.releasePointerCapture(id)
            if (el.hasPointerCapture(id)) el.releasePointerCapture(id)
          } catch {
            /* capture already gone */
          }
          // (useTouchDragGuard keeps the finger from scrolling the list while the drag is active.)
        }
      }
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== id || started) return
        const d = Math.hypot(ev.clientX - sx, ev.clientY - sy)
        if (touch) {
          if (d > TOUCH_SLOP) stop() // it's a scroll / swipe
        } else if (d > 4) begin()
      }
      const stop = () => {
        window.clearTimeout(timer)
        el.classList.remove('is-pressing')
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', cancel)
        // Keep swallowing the long-press context menu until the finger lifts.
        window.setTimeout(() => window.removeEventListener('contextmenu', noMenu, true), 400)
      }
      const up = (ev: PointerEvent) => {
        if (ev.pointerId === id) stop()
      }
      const cancel = (ev: PointerEvent) => {
        if (ev.pointerId !== id) return
        // The browser took the gesture over (e.g. started scrolling): abandon a drag in progress.
        if (started && useOffice.getState().drag?.taskId === taskId) useOffice.getState().cancelDrag()
        stop()
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', cancel)
      if (touch) {
        window.addEventListener('contextmenu', noMenu, true)
        el.classList.add('is-pressing')
        timer = window.setTimeout(begin, LONG_PRESS_MS)
      }
    },
    [taskId],
  )
  const consumeClick = useCallback(() => {
    if (!moved.current) return false
    moved.current = false
    return true
  }, [])
  return { onPointerDown, consumeClick }
}

/** Open tasks on the agenda, in the order a meeting uses them (priority desc, then number). */
export function agendaOrder(tasks: Record<Id, Task>): Task[] {
  return Object.values(tasks)
    .filter((t) => t.onAgenda === true && isOpen(t))
    .sort((a, b) => PRIORITY_META[b.priority].weight - PRIORITY_META[a.priority].weight || a.number - b.number)
}

export function useAgendaTasks(): Task[] {
  const tasks = useOffice((s) => s.tasks)
  return useMemo(() => agendaOrder(tasks), [tasks])
}
