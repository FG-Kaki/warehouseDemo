// Weekly plan: member x weekday grid of open tasks by due date. Chips drag between cells. OWNER: ui-builder.
import { memo, useMemo } from 'react'
import type { Id, Member, Task } from '../data/types'
import { PRIORITY_META } from '../data/meta'
import { isOpen, taskKey, todayIso, workloadLevel } from '../data/selectors'
import { useOffice } from '../store'
import { Avatar, Empty, PriorityDot } from './common'
import { addDays, cssVars, formatMonthDay, mondayOf, parseIso } from './format'
import { useMemberList, useNow, useTaskDrag } from './hooks'
import { Icon } from './icons'
import { useUi } from './uiState'

const DAY_NAMES = ['월', '화', '수', '목', '금']
/** Row id of the unassigned row (member ids never equal this). */
const NONE = '__none__'

interface Col {
  id: string
  label: string
  sub?: string
  /** Due date a drop here sets; null = not a drop target (the overdue column). */
  date: string | null
  /** Every calendar date this column shows (the weekend column holds Sat + Sun). */
  dates?: string[]
  kind: 'late' | 'day' | 'weekend'
  today?: boolean
}

function weekLabel(offset: number) {
  if (offset === 0) return '이번 주'
  if (offset === -1) return '지난주'
  if (offset === 1) return '다음 주'
  return offset < 0 ? `${-offset}주 전` : `${offset}주 뒤`
}

const Chip = memo(function Chip({ taskId, overdue }: { taskId: Id; overdue: boolean }) {
  const task = useOffice((s) => s.tasks[taskId])
  const projectKey = useOffice((s) => s.projects[s.tasks[taskId]?.projectId ?? '']?.key)
  const hovered = useOffice((s) => s.hover?.kind === 'task' && s.hover.id === taskId)
  const selected = useOffice((s) => s.selection?.kind === 'task' && s.selection.id === taskId)
  const dragging = useOffice((s) => s.drag?.taskId === taskId)
  const { onPointerDown, consumeClick } = useTaskDrag(taskId)
  if (!task) return null
  const select = () => useOffice.getState().select({ kind: 'task', id: taskId })
  return (
    <div
      role="button"
      tabIndex={0}
      className={`wk-chip${hovered ? ' is-hover' : ''}${selected ? ' is-selected' : ''}${dragging ? ' is-dragging' : ''}${overdue ? ' is-overdue' : ''}`}
      title={`${taskKey(task, projectKey)} · ${task.title} · ${task.estimate}pt`}
      onPointerDown={onPointerDown}
      onPointerEnter={() => {
        if (!useOffice.getState().drag) useOffice.getState().setHover({ kind: 'task', id: taskId })
      }}
      onPointerLeave={() => useOffice.getState().setHover(null)}
      onClick={() => {
        if (!consumeClick()) select()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          select()
        }
      }}
    >
      <div className="wk-chip-top">
        <PriorityDot priority={task.priority} />
        <span className="wk-key">{taskKey(task, projectKey)}</span>
        <span className="wk-pt">{task.estimate}</span>
      </div>
      <div className="wk-chip-title">{task.title}</div>
    </div>
  )
})

const Cell = memo(function Cell({
  col,
  memberId,
  tasks,
  today,
}: {
  col: Col
  /** Id to assign on drop; null = the unassigned row. */
  memberId: Id | null
  tasks: Task[]
  today: string
}) {
  const date = col.date
  const own = col.dates ?? (date !== null ? [date] : [])
  const isTarget = useOffice((s) => s.dropTarget?.kind === 'day' && own.includes(s.dropTarget.date) && s.dropTarget.memberId === memberId)
  const armed = useOffice((s) => s.drag !== null)
  const claim = () => {
    const st = useOffice.getState()
    if (!st.drag) return
    if (date === null) {
      if (st.dropTarget?.kind === 'day') st.setDropTarget(null)
      return
    }
    // Keep the task's own date when it already falls in this column (Sat/Sun in the weekend column).
    const dragged = st.tasks[st.drag.taskId]
    const target = dragged?.dueDate && own.includes(dragged.dueDate) ? dragged.dueDate : date
    const cur = st.dropTarget
    if (cur?.kind === 'day' && cur.date === target && cur.memberId === memberId) return
    st.setDropTarget({ kind: 'day', date: target, memberId })
  }
  const release = () => {
    const st = useOffice.getState()
    const cur = st.dropTarget
    if (cur?.kind === 'day' && own.includes(cur.date) && cur.memberId === memberId) st.setDropTarget(null)
  }
  const total = tasks.reduce((s, t) => s + t.estimate, 0)
  return (
    <div
      className={`wk-cell wk-${col.kind}${col.today ? ' is-today' : ''}${isTarget ? ' is-target' : ''}${armed && date !== null ? ' is-armed' : ''}`}
      onPointerEnter={claim}
      onPointerMove={claim}
      onPointerLeave={release}
    >
      {tasks.map((t) => (
        <Chip key={t.id} taskId={t.id} overdue={t.dueDate !== null && t.dueDate < today} />
      ))}
      {total > 0 && <span className="wk-total">{total}pt</span>}
      {isTarget && tasks.length === 0 && <span className="wk-drop">놓기</span>}
    </div>
  )
})

function RowLabel({ member, points, late, thisWeek }: { member: Member | null; points: number; late: number; thisWeek: boolean }) {
  if (!member) {
    return (
      <div className="wk-label">
        <div className="wk-who">
          <Avatar size={20} />
          <span className="wk-name">미배정</span>
        </div>
        <span className="wk-sub">{points}pt</span>
      </div>
    )
  }
  const ratio = member.capacity > 0 ? points / member.capacity : points > 0 ? 2 : 0
  const level = workloadLevel(ratio)
  const select = () => useOffice.getState().select({ kind: 'member', id: member.id })
  return (
    <div
      className="wk-label is-member"
      role="button"
      tabIndex={0}
      title={`${member.name} · ${thisWeek ? '이번 주' : '이 주'} ${points}/${member.capacity}pt${late > 0 ? ` (지연 ${late}pt 포함)` : ''} · ${level.label}`}
      onClick={select}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          select()
        }
      }}
      onPointerEnter={() => {
        if (!useOffice.getState().drag) useOffice.getState().setHover({ kind: 'member', id: member.id })
      }}
      onPointerLeave={() => useOffice.getState().setHover(null)}
    >
      <div className="wk-who">
        <Avatar member={member} size={20} />
        <span className="wk-name">{member.name}</span>
      </div>
      <div className="wk-load" style={cssVars({ '--c': level.color })}>
        <div className="wl-bar">
          <i style={{ width: `${Math.min(1, ratio) * 100}%` }} />
        </div>
        <span className="wk-sub">
          {points}/{member.capacity}
        </span>
      </div>
    </div>
  )
}

export function WeekView() {
  const tasks = useOffice((s) => s.tasks)
  const members = useMemberList()
  const offset = useUi((s) => s.weekOffset)
  // Re-render each minute so the view rolls over at midnight.
  const nowMs = useNow(60_000)
  const today = todayIso(new Date(nowMs))

  const weekStart = useMemo(() => mondayOf(addDays(today, offset * 7)), [offset, today])

  const cols = useMemo<Col[]>(() => {
    const t = today
    const out: Col[] = []
    if (offset === 0) out.push({ id: 'late', label: '지연', date: null, kind: 'late' })
    for (let i = 0; i < 5; i++) {
      const date = addDays(weekStart, i)
      out.push({ id: date, label: DAY_NAMES[i], sub: String(parseIso(date).getDate()), date, kind: 'day', today: date === t })
    }
    const sat = addDays(weekStart, 5)
    out.push({ id: 'weekend', label: '주말', date: sat, dates: [sat, addDays(weekStart, 6)], kind: 'weekend', today: sat === t || addDays(weekStart, 6) === t })
    return out
  }, [weekStart, offset, today])

  const { cells, points, late, noDue } = useMemo(() => {
    const cells = new Map<string, Task[]>()
    const points: Record<string, number> = {}
    const late: Record<string, number> = {}
    let noDue = 0
    const memberIds = new Set(members.map((m) => m.id))
    const sun = addDays(weekStart, 6)
    const lastWeekday = addDays(weekStart, 4)
    const sat = addDays(weekStart, 5)
    for (const t of Object.values(tasks)) {
      if (!isOpen(t)) continue
      if (!t.dueDate) {
        noDue++
        continue
      }
      let col: string | null = null
      if (t.dueDate < weekStart) col = offset === 0 ? 'late' : null
      else if (t.dueDate <= lastWeekday) col = t.dueDate
      else if (t.dueDate === sat || t.dueDate === sun) col = 'weekend'
      if (col === null) continue
      const row = t.assigneeId && memberIds.has(t.assigneeId) ? t.assigneeId : NONE
      const key = `${row}|${col}`
      const list = cells.get(key)
      if (list) list.push(t)
      else cells.set(key, [t])
      points[row] = (points[row] ?? 0) + t.estimate
      if (col === 'late') late[row] = (late[row] ?? 0) + t.estimate
    }
    for (const list of cells.values()) {
      list.sort((a, b) => PRIORITY_META[b.priority].weight - PRIORITY_META[a.priority].weight || a.number - b.number)
    }
    return { cells, points, late, noDue }
  }, [tasks, members, weekStart, offset])

  const gridStyle = cssVars({ '--wk-cols': `100px ${offset === 0 ? '72px ' : ''}repeat(5, minmax(0, 1fr)) 72px` })
  const rangeText = `${formatMonthDay(weekStart)} – ${formatMonthDay(addDays(weekStart, 4))}`
  const anyChip = cells.size > 0
  const setOffset = (n: number) => useUi.getState().setWeekOffset(n)

  const renderRow = (rowId: string, member: Member | null) => (
    <div className="wk-row" key={rowId} style={gridStyle}>
      <RowLabel member={member} points={points[rowId] ?? 0} late={late[rowId] ?? 0} thisWeek={offset === 0} />
      {cols.map((c) => (
        <Cell key={c.id} col={c} memberId={member ? member.id : null} tasks={cells.get(`${rowId}|${c.id}`) ?? EMPTY} today={today} />
      ))}
    </div>
  )

  return (
    <div className="wk">
      <div className="wk-bar">
        <button type="button" className="btn btn-icon btn-sm btn-ghost" aria-label="이전 주" title="이전 주" onClick={() => setOffset(offset - 1)}>
          <Icon name="chevronLeft" size={16} />
        </button>
        <button type="button" className="btn btn-sm wk-now" onClick={() => setOffset(0)} disabled={offset === 0} title="이번 주로 돌아가기">
          {weekLabel(offset)}
        </button>
        <button type="button" className="btn btn-icon btn-sm btn-ghost" aria-label="다음 주" title="다음 주" onClick={() => setOffset(offset + 1)}>
          <Icon name="chevronRight" size={16} />
        </button>
        <span className="wk-range">{rangeText}</span>
      </div>

      <div className="wk-scroll">
        <div className="wk-head" style={gridStyle}>
          <span />
          {cols.map((c) => (
            <span key={c.id} className={`wk-h wk-h-${c.kind}${c.today ? ' is-today' : ''}`} title={c.kind === 'weekend' ? '토요일 마감으로 설정돼요' : undefined}>
              {c.label}
              {c.sub && <b>{c.sub}</b>}
            </span>
          ))}
        </div>
        {renderRow(NONE, null)}
        {members.map((m) => renderRow(m.id, m))}
        {members.length === 0 && <Empty icon="users" title="아직 팀원이 없어요" hint="팀원을 추가하면 주간 계획에 행이 생겨요." />}
      </div>

      <footer className="wk-foot">
        <span>마감 없는 작업 {noDue}개</span>
        <span className="dim">{anyChip ? '작업을 끌어 다른 칸에 놓으면 마감일이 바뀌어요' : '이 주에는 마감이 잡힌 작업이 없어요'}</span>
      </footer>
    </div>
  )
}

const EMPTY: Task[] = []
