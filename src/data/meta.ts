// Labels, colors and option lists for domain enums. Owned by the architect.
import type { Estimate, Presence, Priority, TaskStatus } from './types'

export const STATUSES: TaskStatus[] = ['todo', 'in_progress', 'review', 'done']
export const STATUS_META: Record<TaskStatus, { label: string; color: string }> = {
  todo: { label: '할 일', color: '#8a94a8' },
  in_progress: { label: '진행 중', color: '#3a6df0' },
  review: { label: '검토', color: '#9b5de5' },
  done: { label: '완료', color: '#22b07d' },
}

export const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low']
export const PRIORITY_META: Record<Priority, { label: string; color: string; weight: number }> = {
  urgent: { label: '긴급', color: '#e5484d', weight: 4 },
  high: { label: '높음', color: '#f08a24', weight: 3 },
  medium: { label: '보통', color: '#e8c33a', weight: 2 },
  low: { label: '낮음', color: '#9fb0c8', weight: 1 },
}

export const ESTIMATES: Estimate[] = [1, 2, 3, 5, 8]

export const PRESENCE_META: Record<Presence, { label: string; color: string }> = {
  working: { label: '작업 중', color: '#22b07d' },
  meeting: { label: '회의 중', color: '#9b5de5' },
  break: { label: '휴식', color: '#e8a33a' },
  away: { label: '자리 비움', color: '#9aa3b5' },
}

/** Avatar / member chip colors offered in the member form. */
export const MEMBER_COLORS = ['#3a6df0', '#e05fa8', '#22b07d', '#f08a24', '#9b5de5', '#14a3b8', '#e5484d', '#6b7a99', '#c4932b', '#2f9e5b']

export const AVATAR_VARIANTS = 6

/** Workload = open points / capacity. Thresholds for color + wording. */
export const WORKLOAD_LEVELS = [
  { max: 0.6, label: '여유', color: '#22b07d' },
  { max: 1.0, label: '적정', color: '#3a6df0' },
  { max: 1.3, label: '바쁨', color: '#f08a24' },
  { max: Infinity, label: '과부하', color: '#e5484d' },
] as const
