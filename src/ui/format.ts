// Korean-style date / time formatting for the HUD. OWNER: ui-builder.
import type { CSSProperties } from 'react'
import type { Task } from '../data/types'
import { daysUntilDue, isOpen, todayIso } from '../data/selectors'

const DOW = ['일', '월', '화', '수', '목', '금', '토']

export function parseIso(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** "10월 8일 (수)" */
export function formatDate(iso: string): string {
  const dt = parseIso(iso)
  return `${dt.getMonth() + 1}월 ${dt.getDate()}일 (${DOW[dt.getDay()]})`
}

/** "10/8" for tight places. */
export function formatDateShort(iso: string): string {
  const dt = parseIso(iso)
  return `${dt.getMonth() + 1}/${dt.getDate()}`
}

export type Tone = 'bad' | 'warn' | 'ok' | 'dim'

export interface DueInfo {
  text: string
  tone: Tone
  days: number | null
}

/** Due badge text for a task: "2일 남음", "오늘", "3일 지남". */
export function dueInfo(t: Task, today = todayIso()): DueInfo | null {
  if (!t.dueDate) return null
  const d = daysUntilDue(t, today)
  if (d === null) return null
  if (!isOpen(t)) return { text: formatDateShort(t.dueDate), tone: 'dim', days: d }
  if (d < 0) return { text: `${-d}일 지남`, tone: 'bad', days: d }
  if (d === 0) return { text: '오늘', tone: 'warn', days: d }
  if (d <= 2) return { text: `${d}일 남음`, tone: 'warn', days: d }
  return { text: `${d}일 남음`, tone: 'dim', days: d }
}

/** "방금", "3분 전", "2시간 전", "어제", "4일 전", else the date. */
export function relativeTime(iso: string, now = Date.now()): string {
  const at = new Date(iso)
  const diff = now - at.getTime()
  if (Number.isNaN(diff)) return ''
  if (diff < 45_000) return '방금'
  const min = Math.floor(diff / 60_000)
  if (min < 60) return `${Math.max(1, min)}분 전`
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOf(new Date(now)) - startOf(at)) / 86_400_000)
  if (days <= 0) return `${Math.floor(min / 60)}시간 전`
  if (days === 1) return '어제'
  if (days < 7) return `${days}일 전`
  return formatDateShort(iso)
}

export function initialOf(name: string): string {
  return Array.from(name.trim())[0] ?? '?'
}

/** Typed helper for CSS custom properties in inline styles. */
export function cssVars(vars: Record<string, string | number>): CSSProperties {
  return vars as CSSProperties
}

/** ISO date shifted by n days (local calendar). */
export function addDays(iso: string, n: number): string {
  const d = parseIso(iso)
  d.setDate(d.getDate() + n)
  return todayIso(d)
}

/** Monday of the week containing the given ISO date. */
export function mondayOf(iso: string): string {
  const d = parseIso(iso)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return todayIso(d)
}

/** "10월 8일" */
export function formatMonthDay(iso: string): string {
  const dt = parseIso(iso)
  return `${dt.getMonth() + 1}월 ${dt.getDate()}일`
}

/** Local calendar date (ISO) of a datetime string. */
export function localDateOf(datetime: string): string {
  return todayIso(new Date(datetime))
}

/** "방금", "12분", "1시간 5분" between two datetimes (end defaults to now). */
export function formatDuration(startIso: string, endIso?: string | null, now = Date.now()): string {
  const end = endIso ? Date.parse(endIso) : now
  const min = Math.floor((end - Date.parse(startIso)) / 60_000)
  if (Number.isNaN(min) || min < 1) return endIso ? '1분 미만' : '방금'
  if (min < 60) return `${min}분`
  const h = Math.floor(min / 60)
  return min % 60 === 0 ? `${h}시간` : `${h}시간 ${min % 60}분`
}

/** "오후 2:30" */
export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })
}
