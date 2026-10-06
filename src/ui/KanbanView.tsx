// Kanban: stacked collapsible sections (normal) or side-by-side columns (wide). OWNER: ui-builder.
import { memo, useMemo } from 'react'
import type { Id, TaskStatus } from '../data/types'
import { STATUSES, STATUS_META } from '../data/meta'
import { hasActiveFilters, taskKey } from '../data/selectors'
import { useOffice } from '../store'
import { AssigneeChip, Empty, PriorityDot } from './common'
import { cssVars, dueInfo } from './format'
import { useFilteredTasks, useTaskDrag } from './hooks'
import { Icon } from './icons'
import { useUi } from './uiState'

export const TaskCard = memo(function TaskCard({ taskId }: { taskId: Id }) {
  const task = useOffice((s) => s.tasks[taskId])
  const projectKey = useOffice((s) => s.projects[s.tasks[taskId]?.projectId ?? '']?.key)
  const projectColor = useOffice((s) => s.projects[s.tasks[taskId]?.projectId ?? '']?.color)
  const hovered = useOffice((s) => s.hover?.kind === 'task' && s.hover.id === taskId)
  const selected = useOffice((s) => s.selection?.kind === 'task' && s.selection.id === taskId)
  const dragging = useOffice((s) => s.drag?.taskId === taskId)
  const { onPointerDown, consumeClick } = useTaskDrag(taskId)
  if (!task) return null
  const due = dueInfo(task)

  const select = () => useOffice.getState().select({ kind: 'task', id: taskId })
  return (
    <div
      role="button"
      tabIndex={0}
      className={`card${hovered ? ' is-hover' : ''}${selected ? ' is-selected' : ''}${dragging ? ' is-dragging' : ''}`}
      style={cssVars({ '--pc': projectColor ?? 'transparent' })}
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
      <div className="card-top">
        <PriorityDot priority={task.priority} />
        <span className="card-key">{taskKey(task, projectKey)}</span>
        {due && <span className={`due due-${due.tone}`}>{due.text}</span>}
      </div>
      <div className="card-title">{task.title}</div>
      <div className="card-foot">
        <AssigneeChip memberId={task.assigneeId} />
        <span className="est" title="예상 포인트">
          {task.estimate}pt
        </span>
      </div>
    </div>
  )
})

const Column = memo(function Column({ status, ids, wide, total }: { status: TaskStatus; ids: Id[]; wide: boolean; total: number }) {
  const meta = STATUS_META[status]
  const collapsed = useUi((s) => !wide && !!s.collapsed[status])
  const isTarget = useOffice((s) => s.dropTarget?.kind === 'status' && s.dropTarget.status === status)
  const dragging = useOffice((s) => s.drag !== null)

  const claim = () => {
    const st = useOffice.getState()
    if (!st.drag) return
    const cur = st.dropTarget
    if (cur?.kind === 'status' && cur.status === status) return
    st.setDropTarget({ kind: 'status', status })
  }
  const release = () => {
    const st = useOffice.getState()
    if (st.dropTarget?.kind === 'status' && st.dropTarget.status === status) st.setDropTarget(null)
  }

  return (
    <section
      className={`col${wide ? ' col-wide' : ''}${collapsed ? ' is-collapsed' : ''}${isTarget ? ' is-target' : ''}${dragging ? ' is-armed' : ''}`}
      style={cssVars({ '--c': meta.color })}
      onPointerEnter={claim}
      onPointerMove={claim}
      onPointerLeave={release}
    >
      <button
        type="button"
        className="col-head"
        onClick={() => !wide && useUi.getState().toggleCollapsed(status)}
        aria-expanded={!collapsed}
        disabled={wide}
      >
        {!wide && <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={14} />}
        <i className="dot" />
        <strong>{meta.label}</strong>
        <span className="col-count">{ids.length === total ? ids.length : `${ids.length}/${total}`}</span>
        {isTarget && <span className="col-drop">여기에 놓기</span>}
      </button>
      {!collapsed && (
        <div className="col-body">
          {ids.length === 0 ? <div className="col-empty">{dragging ? `놓으면 ${meta.label} 상태가 돼요` : '비어 있어요'}</div> : ids.map((id) => <TaskCard key={id} taskId={id} />)}
        </div>
      )}
    </section>
  )
})

export function KanbanView() {
  const wide = useUi((s) => s.wide)
  const filtered = useFilteredTasks()
  const totals = useOffice((s) => s.tasks)
  const filters = useOffice((s) => s.filters)

  const { groups, totalByStatus } = useMemo(() => {
    const groups: Record<TaskStatus, Id[]> = { todo: [], in_progress: [], review: [], done: [] }
    const sorted = [...filtered].sort((a, b) => a.order - b.order)
    for (const t of sorted) groups[t.status].push(t.id)
    const totalByStatus: Record<TaskStatus, number> = { todo: 0, in_progress: 0, review: 0, done: 0 }
    for (const t of Object.values(totals)) totalByStatus[t.status]++
    return { groups, totalByStatus }
  }, [filtered, totals])

  if (filtered.length === 0) {
    return hasActiveFilters(filters) ? <FilteredEmpty /> : <NoTasks />
  }

  return (
    <div className={`kanban${wide ? ' kanban-wide' : ''}`}>
      {STATUSES.map((s) => (
        <Column key={s} status={s} ids={groups[s]} wide={wide} total={totalByStatus[s]} />
      ))}
    </div>
  )
}

export function FilteredEmpty() {
  return (
    <Empty
      icon="search"
      title="필터에 맞는 작업이 없어요"
      hint="조건을 바꾸거나 필터를 초기화해 보세요."
      action={
        <button type="button" className="btn btn-sm" onClick={() => useOffice.getState().clearFilters()}>
          필터 초기화
        </button>
      }
    />
  )
}

export function NoTasks() {
  return (
    <Empty
      title="아직 작업이 없어요"
      hint="첫 작업을 만들어 팀에 배정해 보세요."
      action={
        <button type="button" className="btn btn-sm btn-primary" onClick={() => useOffice.getState().openDialog({ kind: 'task' })}>
          <Icon name="plus" size={14} />
          작업 만들기
        </button>
      }
    />
  )
}
