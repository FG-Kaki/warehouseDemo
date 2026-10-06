// Per-member status signal as a primitive string (so zustand selectors can compare by value), plus a
// `today` hook that rolls over at midnight so overdue states update without a task change.
import { useEffect, useState } from 'react'
import { memberSignal, type MemberSignal, type SignalLevel } from '../data/insights'
import { todayIso } from '../data/selectors'
import type { Id, Member, Task } from '../data/types'

interface Cached {
  member: Member
  tasks: Record<Id, Task>
  today: string
  key: string
}
const cache = new Map<Id, Cached>()

/** "level|reason;reason" — recomputed only when the member, the tasks map or the day changes. */
export function signalKeyOf(member: Member, tasks: Record<Id, Task>, today: string): string {
  const c = cache.get(member.id)
  if (c && c.member === member && c.tasks === tasks && c.today === today) return c.key
  const sig = memberSignal(member, tasks, today)
  const key = `${sig.level}|${sig.reasons.join(';')}`
  cache.set(member.id, { member, tasks, today, key })
  return key
}

export function parseSignalKey(key: string): MemberSignal {
  const i = key.indexOf('|')
  const rest = key.slice(i + 1)
  return { level: key.slice(0, i) as SignalLevel, reasons: rest ? rest.split(';') : [] }
}

/** Local YYYY-MM-DD, updated shortly after midnight. */
export function useToday(): string {
  const [today, setToday] = useState(() => todayIso())
  useEffect(() => {
    let timer: number
    const arm = () => {
      const now = new Date()
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1)
      timer = window.setTimeout(() => {
        setToday(todayIso())
        arm()
      }, Math.max(1000, next.getTime() - now.getTime()))
    }
    arm()
    return () => window.clearTimeout(timer)
  }, [])
  return today
}
