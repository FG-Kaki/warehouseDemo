// Computes every task's target slot and renders one persistent TaskBox per task (keyed by id).
import { useMemo, useRef, type ReactElement } from 'react'
import { hasActiveFilters, matchesFilters } from '../data/selectors'
import type { Id } from '../data/types'
import { useOffice } from '../store'
import { TaskBox } from './TaskBox'
import { useToday } from './signals'
import { computeSlots, type Slot } from './slots'

const NONE = new Set<Id>()

export function TaskBoxes() {
  const tasks = useOffice((s) => s.tasks)
  const members = useOffice((s) => s.members)
  const filters = useOffice((s) => s.filters)
  const overlay = useOffice((s) => s.overlay)
  const status = useOffice((s) => s.status)
  const today = useToday()

  const doneAssign = useRef(new Map<Id, number>())
  const prevSlots = useRef(new Map<Id, Slot>())
  const popped = useRef(new Map<Id, boolean>())
  const firstBatch = useRef(true)

  const slots = useMemo(() => {
    const next = computeSlots(tasks, members, doneAssign.current, prevSlots.current)
    prevSlots.current = next
    return next
  }, [tasks, members])

  const dimmed = useMemo(() => {
    if (!hasActiveFilters(filters)) return NONE
    const out = new Set<Id>()
    for (const t of Object.values(tasks)) if (!matchesFilters(t, filters, today)) out.add(t.id)
    return out
  }, [tasks, filters, today])

  // Boxes present in the first loaded workspace are simply there; later ones pop in.
  for (const id of slots.keys()) {
    if (!popped.current.has(id)) popped.current.set(id, !firstBatch.current)
  }
  if (status === 'ready') firstBatch.current = false

  const items: ReactElement[] = []
  for (const [id, slot] of slots) {
    items.push(<TaskBox key={id} id={id} slot={slot} dimmed={dimmed.has(id)} overlay={overlay} today={today} pop={popped.current.get(id) ?? false} />)
  }
  return <>{items}</>
}
