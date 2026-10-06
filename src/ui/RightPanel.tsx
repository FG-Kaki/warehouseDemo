// Right rail: detail drawer on top, management panel (tabs + filters + body) below. OWNER: ui-builder.
import { useOffice } from '../store'
import { DetailDrawer } from './Detail'
import { FilterBar } from './FilterBar'
import { Icon } from './icons'
import { KanbanView } from './KanbanView'
import { ListView } from './ListView'
import { TeamView } from './TeamView'
import { useUi, type Tab } from './uiState'

const TABS: { id: Tab; label: string }[] = [
  { id: 'kanban', label: '칸반' },
  { id: 'list', label: '목록' },
  { id: 'team', label: '팀원' },
]

function Panel() {
  const tab = useUi((s) => s.tab)
  const wide = useUi((s) => s.wide)
  const taskCount = useOffice((s) => Object.keys(s.tasks).length)
  const memberCount = useOffice((s) => Object.keys(s.members).length)
  const ui = useUi.getState()

  return (
    <section className="panel glass" aria-label="관리 패널">
      <header className="panel-head">
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? 'is-on' : ''}
              onClick={() => ui.setTab(t.id)}
            >
              {t.label}
              <span className="tab-count">{t.id === 'team' ? memberCount : taskCount}</span>
            </button>
          ))}
        </div>
        <span className="grow" />
        <button
          type="button"
          className={`btn btn-sm btn-ghost${wide ? ' is-on' : ''}`}
          onClick={() => ui.setWide(!wide)}
          aria-pressed={wide}
          title={wide ? '좁게' : '넓게'}
        >
          <Icon name={wide ? 'shrink' : 'expand'} size={14} />
          {wide ? '좁게' : '넓게'}
        </button>
        <button type="button" className="btn btn-icon btn-ghost" onClick={() => ui.setPanelOpen(false)} aria-label="패널 접기" title="패널 접기">
          <Icon name="chevronRight" size={16} />
        </button>
      </header>
      {tab !== 'team' && <FilterBar />}
      <div className={`panel-body panel-${tab}${tab === 'kanban' && wide ? ' is-wide-kanban' : ''}`}>
        {tab === 'kanban' && <KanbanView />}
        {tab === 'list' && <ListView />}
        {tab === 'team' && <TeamView />}
      </div>
    </section>
  )
}

export function Rail() {
  const panelOpen = useUi((s) => s.panelOpen)
  return (
    <div className="rail">
      <DetailDrawer />
      {panelOpen ? (
        <Panel />
      ) : (
        <button type="button" className="panel-reopen glass" onClick={() => useUi.getState().setPanelOpen(true)} title="관리 패널 열기">
          <Icon name="chevronLeft" size={15} />
          관리 패널
        </button>
      )}
    </div>
  )
}
