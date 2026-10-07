// Top bar: wordmark, KPI chips, demo toggle, overlay switch, create buttons. OWNER: ui-builder.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { MAX_MEMBERS } from '../office/layout'
import { WORKLOAD_LEVELS } from '../data/meta'
import { computeKpis } from '../data/selectors'
import { ongoingMeeting, useOffice, type Overlay } from '../store'
import { AnimatedNumber } from './common'
import { cssVars, formatDuration } from './format'
import { useNow, useProjectList } from './hooks'
import { Icon } from './icons'
import { useUi } from './uiState'
import { ConnectionBanner, Toasts } from './Toasts'
import { Suggestions } from './Suggestions'

const OVERLAYS: { id: Overlay; label: string; key: string }[] = [
  { id: 'none', label: '기본', key: '1' },
  { id: 'workload', label: '업무량', key: '2' },
  { id: 'deadline', label: '마감 위험', key: '3' },
  { id: 'project', label: '프로젝트', key: '4' },
]

/** Make sure the task lists are visible after a KPI click. */
function revealTasks() {
  const ui = useUi.getState()
  ui.setPanelOpen(true)
  if (ui.tab === 'team' || ui.tab === 'week') ui.setTab('kanban')
}

function Kpi({
  label,
  bad,
  active,
  onClick,
  title,
  children,
}: {
  label: string
  bad?: boolean
  active?: boolean
  onClick?: () => void
  title?: string
  children: ReactNode
}) {
  const cls = `kpi${bad ? ' kpi-bad' : ''}${active ? ' is-active' : ''}`
  const body = (
    <>
      <span className="kpi-value">{children}</span>
      <span className="kpi-label">{label}</span>
    </>
  )
  return onClick ? (
    <button type="button" className={`${cls} kpi-click`} onClick={onClick} title={title} aria-pressed={active}>
      {body}
    </button>
  ) : (
    <div className={cls} title={title}>
      {body}
    </div>
  )
}

function imbalanceLabel(v: number) {
  if (v < 0.35) return { text: '균형', tone: 'good' as const }
  if (v < 0.7) return { text: '약간 쏠림', tone: 'warn' as const }
  return { text: '쏠림', tone: 'bad' as const }
}

function KpiRow() {
  const tasks = useOffice((s) => s.tasks)
  const members = useOffice((s) => s.members)
  const { overdueOnly, unassignedOnly } = useOffice(
    useShallow((s) => ({
      overdueOnly: s.filters.overdueOnly,
      unassignedOnly: s.filters.assigneeIds.length === 1 && s.filters.assigneeIds[0] === 'unassigned',
    })),
  )
  const kpis = useMemo(() => computeKpis(tasks, members), [tasks, members])
  const busiest = kpis.busiestId ? members[kpis.busiestId] : undefined
  const memberCount = Object.keys(members).length
  const imb = imbalanceLabel(kpis.imbalance)

  return (
    <div className="kpis">
      <Kpi label="진행 중">
        <AnimatedNumber value={kpis.inProgress} />
      </Kpi>
      <Kpi
        label="지연"
        bad={kpis.overdue > 0}
        active={overdueOnly}
        title={overdueOnly ? '지연 필터 끄기' : '지연된 작업만 보기'}
        onClick={() => {
          revealTasks()
          useOffice.getState().setFilters({ overdueOnly: !overdueOnly })
        }}
      >
        <AnimatedNumber value={kpis.overdue} />
      </Kpi>
      <Kpi
        label="미배정"
        active={unassignedOnly}
        title={unassignedOnly ? '미배정 필터 끄기' : '미배정 작업만 보기'}
        onClick={() => {
          revealTasks()
          useOffice.getState().setFilters({ assigneeIds: unassignedOnly ? [] : ['unassigned'] })
        }}
      >
        <AnimatedNumber value={kpis.unassigned} />
      </Kpi>
      <Kpi label="이번 주 완료">
        <AnimatedNumber value={kpis.doneThisWeek} />
      </Kpi>
      {memberCount > 0 && (
        <span
          className={`balance balance-${imb.tone}`}
          title={`업무 편중도: ${imb.text}${busiest && imb.tone !== 'good' ? ` · 가장 바쁜 팀원 ${busiest.name} 님` : ''}`}
        >
          <i className="dot" />
          {imb.text}
        </span>
      )}
    </div>
  )
}

function OverlaySwitch() {
  const overlay = useOffice((s) => s.overlay)
  const projects = useProjectList()
  return (
    <div className={`overlay-row glass${overlay === 'none' ? ' is-plain' : ''}`}>
      <div className="seg" role="radiogroup" aria-label="화면 오버레이">
        {OVERLAYS.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={overlay === o.id}
            className={overlay === o.id ? 'is-on' : ''}
            onClick={() => useOffice.getState().setOverlay(o.id)}
            title={`${o.label} (${o.key})`}
          >
            {o.label}
          </button>
        ))}
      </div>
      {overlay !== 'none' && (
      <div className="legend" key={overlay}>
        {overlay === 'workload' &&
          WORKLOAD_LEVELS.map((l) => (
            <span key={l.label} className="legend-item">
              <i className="dot" style={cssVars({ '--c': l.color })} />
              {l.label}
            </span>
          ))}
        {overlay === 'deadline' && (
          <>
            <span className="legend-item">
              <i className="dot" style={cssVars({ '--c': 'var(--good)' })} />
              여유
            </span>
            <span className="legend-item">
              <i className="dot" style={cssVars({ '--c': 'var(--warn)' })} />
              임박
            </span>
            <span className="legend-item">
              <i className="dot" style={cssVars({ '--c': 'var(--bad)' })} />
              지연
            </span>
          </>
        )}
        {overlay === 'project' &&
          projects.map((p) => (
            <span key={p.id} className="legend-item" title={p.name}>
              <i className="dot" style={cssVars({ '--c': p.color })} />
              {p.key}
            </span>
          ))}
      </div>
      )}
    </div>
  )
}

/** "회의" button with the agenda count; becomes a slim live pill while a meeting is ongoing. */
function MeetingControl() {
  const live = useOffice((s) => ongoingMeeting(s.meetings))
  const agendaCount = useOffice((s) => {
    let n = 0
    for (const t of Object.values(s.tasks)) if (t.onAgenda === true && t.status !== 'done') n++
    return n
  })
  const now = useNow(15_000)
  if (live) {
    const elapsed = formatDuration(live.startedAt, null, now)
    const minutes = Math.max(0, Math.floor((now - Date.parse(live.startedAt)) / 60_000))
    return (
      <div className="meet-live" role="status" title={`${live.title} · 진행 중 ${elapsed} · 참석 ${live.attendeeIds.length}명 · 안건 ${live.agendaTaskIds.length}개`}>
        <i className="meet-dot" aria-hidden="true" />
        <b className="meet-elapsed">{minutes}분</b>
        <span className="meet-meta">
          {live.title} · 참석 {live.attendeeIds.length} · 안건 {live.agendaTaskIds.length}
        </span>
        <button type="button" className="btn btn-sm meet-end" onClick={() => useOffice.getState().openDialog({ kind: 'endMeeting', meetingId: live.id })} title="회의 종료 (M)" aria-label="회의 종료">
          종료
        </button>
      </div>
    )
  }
  return (
    <button type="button" className="btn" onClick={() => useOffice.getState().openDialog({ kind: 'startMeeting' })} title="회의 시작 (M)">
      <Icon name="meeting" size={14} />
      회의
      {agendaCount > 0 && (
        <span className="badge" title={`안건 ${agendaCount}개`}>
          {agendaCount}
        </span>
      )}
    </button>
  )
}

function MoreMenu({ onReset }: { onReset: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const canReset = useOffice((s) => s.canReset)
  const full = useOffice((s) => Object.keys(s.members).length >= MAX_MEMBERS)
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('pointerdown', down)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('keydown', key, true)
    }
  }, [open])
  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className="btn btn-icon btn-ghost" aria-haspopup="menu" aria-expanded={open} title="더보기" onClick={() => setOpen((o) => !o)}>
        <Icon name="more" />
      </button>
      {open && (
        <div className="menu glass" role="menu">
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={full}
            title={full ? `자리가 가득 찼어요 (최대 ${MAX_MEMBERS}명)` : undefined}
            onClick={() => {
              setOpen(false)
              useOffice.getState().openDialog({ kind: 'member' })
            }}
          >
            <Icon name="users" size={15} />
            팀원 추가
            {full && <span className="menu-note">가득 참</span>}
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpen(false)
              useUi.getState().setHistoryOpen(true)
            }}
          >
            <Icon name="history" size={15} />
            회의록
          </button>
          {canReset && (
            <>
              <hr className="menu-sep" />
              <button
                type="button"
                role="menuitem"
                className="menu-item menu-danger"
                onClick={() => {
                  setOpen(false)
                  onReset()
                }}
              >
                <Icon name="refresh" size={15} />
                데이터 초기화
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function TopBar() {
  const { sourceLabel, canDemo, demoMode } = useOffice(
    useShallow((s) => ({ sourceLabel: s.sourceLabel, canDemo: s.canDemo, demoMode: s.demoMode })),
  )
  const status = useOffice((s) => s.status)
  const connection = useOffice((s) => s.connection)
  return (
    <div className="hud-top">
      <div className="top-head">
      <header className="topbar glass">
        <div className="brand" title={sourceLabel ? `데이터: ${sourceLabel}` : undefined}>
          <span className="brand-mark" aria-hidden="true">
            <Icon name="cube" size={14} />
          </span>
          <span className="brand-name">팀 오피스</span>
          {connection !== null && <span className="badge-server">서버</span>}
        </div>
        <KpiRow />
        <span className="grow" />
        {canDemo && (
          <label className="demo" title="데모 모드 · 팀원 자동 활동">
            <input type="checkbox" role="switch" checked={demoMode} onChange={(e) => useOffice.getState().setDemoMode(e.target.checked)} />
            <span className="switch" aria-hidden="true" />
            <span className="demo-text">데모</span>
          </label>
        )}
        <MeetingControl />
        <button type="button" className="btn btn-primary" onClick={() => useOffice.getState().openDialog({ kind: 'task' })} title="새 작업 (N)">
          <Icon name="plus" size={14} />
          작업
        </button>
        <MoreMenu onReset={() => useOffice.getState().openDialog({ kind: 'confirmReset' })} />
      </header>
      <OverlaySwitch />
      {status === 'error' && (
        <div className="error-banner" role="alert">
          <span className="error-dot" />
          데이터를 불러오지 못했어요
        </div>
      )}
      <ConnectionBanner />
      <Toasts />
      </div>
      <Suggestions />
    </div>
  )
}
