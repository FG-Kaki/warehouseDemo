// Shared hooks for the HUD. OWNER: ui-builder.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Id, Member, Task } from '../data/types'
import { matchesFilters, todayIso, workload, workloadLevel, tasksOf, openPoints } from '../data/selectors'
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

/**
 * Pointer-down + move > 4px on a card starts a panel drag (store.startDrag).
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
      const move = (ev: PointerEvent) => {
        if (moved.current) return
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 4) {
          moved.current = true
          useOffice.getState().startDrag(taskId, 'panel')
        }
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
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
