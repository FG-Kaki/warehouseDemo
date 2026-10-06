// Filter bar for the kanban / list tabs: search + a "필터" toggle that reveals the rest. OWNER: ui-builder.
import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Id, Priority } from '../data/types'
import { PRIORITIES, PRIORITY_META } from '../data/meta'
import { hasActiveFilters } from '../data/selectors'
import { useOffice } from '../store'
import { cssVars } from './format'
import { useMemberList, useProjectList } from './hooks'
import { Icon } from './icons'

function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
}

export function FilterBar() {
  const { text, projectIds, assigneeIds, statuses, priorities, overdueOnly } = useOffice(
    useShallow((s) => ({
      text: s.filters.text,
      projectIds: s.filters.projectIds,
      assigneeIds: s.filters.assigneeIds,
      statuses: s.filters.statuses,
      priorities: s.filters.priorities,
      overdueOnly: s.filters.overdueOnly,
    })),
  )
  const active = useOffice((s) => hasActiveFilters(s.filters))
  const projects = useProjectList()
  const members = useMemberList()
  const [open, setOpen] = useState(false)
  const set = useOffice.getState().setFilters

  const count = projectIds.length + assigneeIds.length + statuses.length + priorities.length + (overdueOnly ? 1 : 0)
  const assigneeValue = assigneeIds.length === 0 ? '' : assigneeIds.length === 1 ? assigneeIds[0] : '__multi'
  // Defensive: a stale id (member removed) gets a labelled fallback instead of a mismatched select.
  const stale = assigneeIds.length === 1 && assigneeIds[0] !== 'unassigned' && !members.some((m) => m.id === assigneeIds[0])

  return (
    <div className="filters">
      <div className="filters-row">
        <label className="search">
          <Icon name="search" size={14} />
          <input
            id="hud-search"
            type="search"
            value={text}
            placeholder="작업 검색  ( / )"
            autoComplete="off"
            onChange={(e) => set({ text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                if (text) set({ text: '' })
                else e.currentTarget.blur()
              }
            }}
          />
        </label>
        <button type="button" className={`btn btn-sm btn-ghost${open || count > 0 ? ' is-on' : ''}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Icon name="filter" size={14} />
          필터
          {count > 0 && <span className="badge">{count}</span>}
        </button>
        {active && (
          <button type="button" className="btn btn-icon btn-sm btn-ghost" title="필터 초기화" aria-label="필터 초기화" onClick={() => useOffice.getState().clearFilters()}>
            <Icon name="close" size={14} />
          </button>
        )}
      </div>

      {open && (
        <div className="filters-pop">
          <div className="fgroup">
            <span className="fgroup-label">담당자</span>
            <select
              className="select select-sm"
              aria-label="담당자 필터"
              value={assigneeValue}
              onChange={(e) => {
                const v = e.target.value
                set({ assigneeIds: v === '' ? [] : [v as Id | 'unassigned'] })
              }}
            >
              <option value="">전체</option>
              <option value="unassigned">미배정</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
              {stale && <option value={assigneeIds[0]}>(내보낸 팀원)</option>}
              {assigneeValue === '__multi' && <option value="__multi">여러 명</option>}
            </select>
          </div>
          {projects.length > 0 && (
            <div className="fgroup">
              <span className="fgroup-label">프로젝트</span>
              <div className="fchips" role="group" aria-label="프로젝트 필터">
                {projects.map((p) => {
                  const on = projectIds.includes(p.id)
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`fchip${on ? ' is-on' : ''}`}
                      style={cssVars({ '--c': p.color })}
                      aria-pressed={on}
                      title={p.name}
                      onClick={() => set({ projectIds: toggle(projectIds, p.id) })}
                    >
                      <i className="dot" />
                      {p.key}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          <div className="fgroup">
            <span className="fgroup-label">우선순위</span>
            <div className="fchips" role="group" aria-label="우선순위 필터">
              {PRIORITIES.map((p: Priority) => {
                const on = priorities.includes(p)
                return (
                  <button
                    key={p}
                    type="button"
                    className={`fchip${on ? ' is-on' : ''}`}
                    style={cssVars({ '--c': PRIORITY_META[p].color })}
                    aria-pressed={on}
                    onClick={() => set({ priorities: toggle(priorities, p) })}
                  >
                    <i className="dot" />
                    {PRIORITY_META[p].label}
                  </button>
                )
              })}
            </div>
          </div>
          <label className="fcheck">
            <input type="checkbox" checked={overdueOnly} onChange={(e) => set({ overdueOnly: e.target.checked })} />
            지연된 작업만
          </label>
        </div>
      )}
    </div>
  )
}
