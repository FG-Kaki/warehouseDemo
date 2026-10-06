// Compact sortable task table. OWNER: ui-builder.
import { memo, useMemo } from 'react'
import type { Id, Task } from '../data/types'
import { PRIORITY_META, STATUSES, STATUS_META } from '../data/meta'
import { hasActiveFilters, taskKey } from '../data/selectors'
import { useOffice } from '../store'
import { AssigneeChip, PriorityDot } from './common'
import { cssVars, dueInfo } from './format'
import { useFilteredTasks } from './hooks'
import { Icon } from './icons'
import { FilteredEmpty, NoTasks } from './KanbanView'
import { useUi, type SortKey } from './uiState'

const COLUMNS: { key: SortKey; label: string; cls: string }[] = [
  { key: 'key', label: '번호', cls: 'c-key' },
  { key: 'title', label: '제목', cls: 'c-title' },
  { key: 'status', label: '상태', cls: 'c-status' },
  { key: 'priority', label: '우선', cls: 'c-prio' },
  { key: 'assignee', label: '담당', cls: 'c-who' },
  { key: 'due', label: '마감', cls: 'c-due' },
  { key: 'estimate', label: 'pt', cls: 'c-est' },
]

const Row = memo(function Row({ taskId }: { taskId: Id }) {
  const task = useOffice((s) => s.tasks[taskId])
  const projectKey = useOffice((s) => s.projects[s.tasks[taskId]?.projectId ?? '']?.key)
  const hovered = useOffice((s) => s.hover?.kind === 'task' && s.hover.id === taskId)
  const selected = useOffice((s) => s.selection?.kind === 'task' && s.selection.id === taskId)
  const assigneeName = useOffice((s) => {
    const a = s.tasks[taskId]?.assigneeId
    return a ? (s.members[a]?.name ?? '') : '미배정'
  })
  if (!task) return null
  const due = dueInfo(task)
  const status = STATUS_META[task.status]
  const key = taskKey(task, projectKey)
  const select = () => useOffice.getState().select({ kind: 'task', id: taskId })
  return (
    <div
      role="row"
      tabIndex={0}
      className={`lrow${hovered ? ' is-hover' : ''}${selected ? ' is-selected' : ''}`}
      onClick={select}
      onKeyDown={(e) => {
        if (e.key === 'Enter') select()
      }}
      onPointerEnter={() => useOffice.getState().setHover({ kind: 'task', id: taskId })}
      onPointerLeave={() => useOffice.getState().setHover(null)}
    >
      <span className="c-key">{key}</span>
      <span className="c-title" title={task.title}>
        <span className="l-title">{task.title}</span>
        <span className="l-sub">{key}</span>
      </span>
      <span className="c-status">
        <span className="spill" style={cssVars({ '--c': status.color })}>
          <i className="dot" />
          {status.label}
        </span>
      </span>
      <span className="c-prio">
        <PriorityDot priority={task.priority} />
      </span>
      <span className="c-who">
        <AssigneeChip memberId={task.assigneeId} showName={false} />
        <span className="l-who-name">{assigneeName}</span>
      </span>
      <span className="c-due">{due ? <span className={`due due-${due.tone}`}>{due.text}</span> : <span className="dim">—</span>}</span>
      <span className="c-est">{task.estimate}</span>
    </div>
  )
})

function sortValue(t: Task, key: SortKey, names: Record<Id, string>): string | number {
  switch (key) {
    case 'key':
      return t.number
    case 'title':
      return t.title
    case 'status':
      return STATUSES.indexOf(t.status)
    case 'priority':
      return PRIORITY_META[t.priority].weight
    case 'assignee':
      return t.assigneeId ? (names[t.assigneeId] ?? '') : '힣힣힣'
    case 'due':
      return t.dueDate ?? '9999-99-99'
    case 'estimate':
      return t.estimate
  }
}

export function ListView() {
  const filtered = useFilteredTasks()
  const filters = useOffice((s) => s.filters)
  const members = useOffice((s) => s.members)
  const sort = useUi((s) => s.sort)
  const wide = useUi((s) => s.wide)

  const ids = useMemo(() => {
    const names: Record<Id, string> = {}
    for (const m of Object.values(members)) names[m.id] = m.name
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...filtered]
      .sort((a, b) => {
        const va = sortValue(a, sort.key, names)
        const vb = sortValue(b, sort.key, names)
        const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'ko')
        return c * dir || a.number - b.number
      })
      .map((t) => t.id)
  }, [filtered, members, sort])

  if (ids.length === 0) return hasActiveFilters(filters) ? <FilteredEmpty /> : <NoTasks />

  return (
    <div className={`ltable${wide ? ' ltable-wide' : ''}`} role="table">
      <div className="lhead" role="row">
        {COLUMNS.map((c) => (
          <button
            key={c.key}
            type="button"
            role="columnheader"
            className={`${c.cls}${sort.key === c.key ? ' is-sorted' : ''}`}
            onClick={() => useUi.getState().setSort(c.key)}
            aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
          >
            {c.label}
            {sort.key === c.key && <Icon name={sort.dir === 'asc' ? 'chevronUp' : 'chevronDown'} size={11} />}
          </button>
        ))}
      </div>
      <div className="lbody">
        {ids.map((id) => (
          <Row key={id} taskId={id} />
        ))}
      </div>
    </div>
  )
}
