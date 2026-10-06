// Bottom-left activity feed. OWNER: ui-builder.
import { memo, useMemo } from 'react'
import type { Activity } from '../data/types'
import { useOffice } from '../store'
import { cssVars, relativeTime } from './format'
import { useNow } from './hooks'
import { Icon } from './icons'
import { useUi } from './uiState'

const SHOWN = 6

const Row = memo(function Row({ activity, now }: { activity: Activity; now: number }) {
  const actor = useOffice((s) => (activity.actorId ? s.members[activity.actorId] : undefined))
  const hasTask = useOffice((s) => !!activity.taskId && !!s.tasks[activity.taskId])
  const hasMember = useOffice((s) => !!activity.memberId && !!s.members[activity.memberId])
  const target = hasTask ? ({ kind: 'task', id: activity.taskId! } as const) : hasMember ? ({ kind: 'member', id: activity.memberId! } as const) : null

  const dot =
    activity.actorId === null ? (
      <span className="feed-actor feed-manager" title="매니저">
        <Icon name="user" size={10} />
      </span>
    ) : (
      <span className="feed-actor" style={cssVars({ '--c': actor?.color ?? '#9aa3b5' })} title={actor?.name} />
    )

  const body = (
    <>
      {dot}
      <span className="feed-msg">{activity.message}</span>
      <time className="feed-time">{relativeTime(activity.at, now)}</time>
    </>
  )
  if (!target) return <li className="feed-row">{body}</li>
  return (
    <li className="feed-row">
      <button
        type="button"
        className="feed-btn"
        onClick={() => {
          const st = useOffice.getState()
          st.select(target)
          st.focusOn(target)
        }}
      >
        {body}
      </button>
    </li>
  )
})

export function ActivityFeed() {
  const activity = useOffice((s) => s.activity)
  const open = useUi((s) => s.feedOpen)
  const now = useNow()
  const latest = useMemo(() => activity.slice(-SHOWN).reverse(), [activity])
  const last = latest[0]

  if (!open) {
    return (
      <button type="button" className="feed feed-pill glass" onClick={() => useUi.getState().setFeedOpen(true)} aria-label="활동 펼치기" title="활동 펼치기">
        <Icon name="pulse" size={14} />
        {last ? (
          <>
            <span key={last.id} className="feed-msg feed-fade">
              {last.message}
            </span>
            <time className="feed-time">{relativeTime(last.at, now)}</time>
          </>
        ) : (
          <span className="feed-msg">활동</span>
        )}
        <Icon name="chevronUp" size={14} className="feed-chev" />
      </button>
    )
  }

  return (
    <section className="feed glass" aria-label="활동 피드">
      <button type="button" className="feed-head" onClick={() => useUi.getState().setFeedOpen(false)} aria-expanded="true">
        <strong>활동</strong>
        <Icon name="chevronDown" size={14} className="feed-chev" />
      </button>
      {latest.length === 0 ? (
        <p className="feed-empty">아직 활동이 없어요.</p>
      ) : (
        <ul className="feed-list">
          {latest.map((a) => (
            <Row key={a.id} activity={a} now={now} />
          ))}
        </ul>
      )}
    </section>
  )
}
