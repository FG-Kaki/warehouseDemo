// Suggested actions (insights.suggestActions): a slim "추천 N" pill under the overlay switch that
// expands to up to 3 cards. Collapses again after an action or on outside click. OWNER: ui-builder.
import { useEffect, useMemo, useRef, useState } from 'react'
import { suggestActions, type Suggestion } from '../data/insights'
import { useOffice } from '../store'
import { Icon } from './icons'
import { useUi } from './uiState'

const SHOWN = 3
const LEAVE_MS = 260

interface Leaving {
  s: Suggestion
  index: number
}

const actionLabel = (s: Suggestion) => (s.kind === 'reassign' ? '넘기기' : '배정하기')

function Card({ s, leaving, onApply, onDismiss }: { s: Suggestion; leaving: boolean; onApply: () => void; onDismiss: () => void }) {
  const toName = useOffice((st) => st.members[s.toId]?.name ?? '팀원')
  const hover = (on: boolean) => {
    if (leaving) return
    useOffice.getState().setHover(on ? { kind: 'task', id: s.taskId } : null)
  }
  return (
    <div
      className={`sug${leaving ? ' is-leaving' : ''}`}
      role="group"
      aria-label="추천"
      onPointerEnter={() => hover(true)}
      onPointerLeave={() => hover(false)}
    >
      <div className="sug-title">{s.title}</div>
      <div className="sug-detail">{s.detail}</div>
      <div className="sug-actions">
        <button type="button" className="btn btn-sm btn-primary" disabled={leaving} title={`${toName} 님에게`} onClick={onApply}>
          {actionLabel(s)}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" disabled={leaving} onClick={onDismiss}>
          닫기
        </button>
        <span className="grow" />
        <button type="button" className="sug-link" disabled={leaving} onClick={() => useOffice.getState().focusOn({ kind: 'task', id: s.taskId })}>
          보기
        </button>
      </div>
    </div>
  )
}

export function Suggestions() {
  const tasks = useOffice((s) => s.tasks)
  const members = useOffice((s) => s.members)
  const dismissed = useUi((s) => s.dismissed)
  const [leaving, setLeaving] = useState<Leaving[]>([])
  const [expanded, setExpanded] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const shown = useRef<Suggestion[]>([])
  const busy = useRef(false)

  const current = useMemo(() => {
    const skip = new Set(dismissed)
    return suggestActions(tasks, members, 12)
      .filter((s) => !skip.has(s.id))
      .slice(0, SHOWN)
  }, [tasks, members, dismissed])
  shown.current = current

  // Outside click collapses the expanded stack.
  useEffect(() => {
    if (!expanded) return
    const down = (e: PointerEvent) => {
      const t = e.target
      if (!(t instanceof Node) || !root.current?.contains(t)) setExpanded(false)
    }
    window.addEventListener('pointerdown', down)
    return () => window.removeEventListener('pointerdown', down)
  }, [expanded])

  const leave = (s: Suggestion, at: number) => {
    setLeaving((l) => [...l, { s, index: Math.max(0, at) }])
    window.setTimeout(() => setLeaving((l) => l.filter((x) => x.s.id !== s.id)), LEAVE_MS)
  }

  const apply = async (s: Suggestion) => {
    if (busy.current) return
    busy.current = true
    const at = shown.current.findIndex((x) => x.id === s.id)
    const st = useOffice.getState()
    const already = st.tasks[s.taskId]?.assigneeId === s.toId
    st.setHover(null)
    // Start the exit animation first so the optimistic update doesn't make the card flash.
    leave(s, at)
    setExpanded(false)
    const ok = await st.assignTask(s.taskId, s.toId)
    busy.current = false
    if (!ok) {
      setLeaving((l) => l.filter((x) => x.s.id !== s.id)) // restore the card
      return
    }
    if (already) return
    const name = useOffice.getState().members[s.toId]?.name ?? '팀원'
    st.toast('good', s.kind === 'reassign' ? `${name} 님에게 넘겼어요` : `${name} 님에게 배정했어요`)
  }

  const items: { s: Suggestion; leaving: boolean }[] = current.filter((c) => !leaving.some((l) => l.s.id === c.id)).map((s) => ({ s, leaving: false }))
  for (const l of leaving) items.splice(Math.min(l.index, items.length), 0, { s: l.s, leaving: true })
  if (items.length === 0) return null

  const live = items.filter((i) => !i.leaving)
  const top = live[0]?.s

  return (
    <div className="suggest" ref={root} aria-label="추천 액션">
      <div
        className="sug-pill glass"
        onPointerEnter={() => {
          if (top && !expanded) useOffice.getState().setHover({ kind: 'task', id: top.taskId })
        }}
        onPointerLeave={() => {
          if (!expanded) useOffice.getState().setHover(null)
        }}
      >
        <button type="button" className="sug-pill-main" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
          <Icon name="spark" size={14} />
          <b>추천 {live.length}</b>
          {!expanded && top && <span className="sug-pill-text">{top.title}</span>}
        </button>
        {!expanded && top && (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void apply(top)}>
            {actionLabel(top)}
          </button>
        )}
        <button type="button" className="btn btn-sm btn-icon btn-ghost" aria-label={expanded ? '접기' : '펼치기'} onClick={() => setExpanded((e) => !e)}>
          <Icon name={expanded ? 'chevronUp' : 'chevronDown'} size={14} />
        </button>
      </div>
      {expanded &&
        items.map(({ s, leaving: isLeaving }) => (
          <Card
            key={s.id}
            s={s}
            leaving={isLeaving}
            onApply={() => void apply(s)}
            onDismiss={() => {
              const at = items.findIndex((i) => i.s.id === s.id)
              useOffice.getState().setHover(null)
              useUi.getState().dismissSuggestion(s.id)
              leave(s, at)
              setExpanded(false)
            }}
          />
        ))}
    </div>
  )
}
