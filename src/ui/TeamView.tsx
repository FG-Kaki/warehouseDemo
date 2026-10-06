// Team tab: member cards that double as drop targets. OWNER: ui-builder.
import { memo, useMemo } from 'react'
import type { Id } from '../data/types'
import { MAX_MEMBERS } from '../office/layout'
import { backlogTasks } from '../data/selectors'
import { memberSignal, type SignalLevel } from '../data/insights'
import { PRESENCE_META } from '../data/meta'
import { useOffice } from '../store'
import { Avatar, Diamond, Empty } from './common'
import { cssVars } from './format'
import { useMemberList, useMemberStats, type MemberStat } from './hooks'
import { Icon } from './icons'

export function WorkloadBar({ stat, capacity }: { stat: MemberStat; capacity: number }) {
  const pct = Math.min(1, stat.ratio) * 100
  return (
    <div className="wl" style={cssVars({ '--c': stat.level.color })}>
      <div className="wl-bar" role="img" aria-label={`업무량 ${stat.points}/${capacity}pt, ${stat.level.label}`}>
        <i style={{ width: `${pct}%` }} />
      </div>
      <span className="wl-text">
        {stat.points}/{capacity}pt
      </span>
      <span className="wl-level">{stat.level.label}</span>
    </div>
  )
}

const MemberCard = memo(function MemberCard({ memberId, stat, level, reasons }: { memberId: Id; stat: MemberStat | undefined; level: SignalLevel; reasons: string }) {
  const member = useOffice((s) => s.members[memberId])
  const hovered = useOffice((s) => s.hover?.kind === 'member' && s.hover.id === memberId)
  const selected = useOffice((s) => s.selection?.kind === 'member' && s.selection.id === memberId)
  const isTarget = useOffice((s) => s.dropTarget?.kind === 'member' && s.dropTarget.id === memberId)
  const armed = useOffice((s) => s.drag !== null)
  if (!member || !stat) return null

  const claim = () => {
    const st = useOffice.getState()
    if (!st.drag) return
    const cur = st.dropTarget
    if (cur?.kind === 'member' && cur.id === memberId) return
    st.setDropTarget({ kind: 'member', id: memberId })
  }
  const select = () => useOffice.getState().select({ kind: 'member', id: memberId })

  return (
    <div
      role="button"
      tabIndex={0}
      className={`mcard${hovered ? ' is-hover' : ''}${selected ? ' is-selected' : ''}${isTarget ? ' is-target' : ''}${armed ? ' is-armed' : ''}`}
      onClick={select}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          select()
        }
      }}
      onPointerEnter={() => {
        claim()
        if (!useOffice.getState().drag) useOffice.getState().setHover({ kind: 'member', id: memberId })
      }}
      onPointerMove={claim}
      onPointerLeave={() => {
        const st = useOffice.getState()
        st.setHover(null)
        if (st.dropTarget?.kind === 'member' && st.dropTarget.id === memberId) st.setDropTarget(null)
      }}
    >
      <Avatar member={member} size={38} />
      <div className="mcard-main">
        <div className="mcard-line">
          <strong className="mcard-name">{member.name}</strong>
          <span className="mcard-role">{member.role}</span>
          <span className="presence" title={reasons || undefined}>
            <Diamond level={level} size={9} title={reasons || undefined} />
            {PRESENCE_META[member.presence].label}
          </span>
        </div>
        <WorkloadBar stat={stat} capacity={member.capacity} />
        <div className="mcard-sub">
          열린 작업 {stat.count}개{isTarget && <span className="mcard-drop"> · 놓으면 배정돼요</span>}
        </div>
      </div>
    </div>
  )
})

function BacklogDrop() {
  const tasks = useOffice((s) => s.tasks)
  const count = useMemo(() => backlogTasks(tasks).length, [tasks])
  const isTarget = useOffice((s) => s.dropTarget?.kind === 'backlog')
  const armed = useOffice((s) => s.drag !== null)
  const claim = () => {
    const st = useOffice.getState()
    if (st.drag && st.dropTarget?.kind !== 'backlog') st.setDropTarget({ kind: 'backlog' })
  }
  return (
    <div
      className={`backlog-drop${isTarget ? ' is-target' : ''}${armed ? ' is-armed' : ''}`}
      onPointerEnter={claim}
      onPointerMove={claim}
      onPointerLeave={() => {
        const st = useOffice.getState()
        if (st.dropTarget?.kind === 'backlog') st.setDropTarget(null)
      }}
    >
      <Icon name="inbox" size={16} />
      <span>
        백로그 <b>{count}</b>개
      </span>
      <span className="dim">{armed ? (isTarget ? '놓으면 미배정이 돼요' : '여기에 놓으면 배정이 해제돼요') : '미배정 작업'}</span>
    </div>
  )
}

export function TeamView() {
  const members = useMemberList()
  const stats = useMemberStats()
  const tasks = useOffice((s) => s.tasks)
  const signals = useMemo(() => {
    const out: Record<Id, { level: SignalLevel; reasons: string }> = {}
    for (const m of members) {
      const sig = memberSignal(m, tasks)
      out[m.id] = { level: sig.level, reasons: sig.reasons.join(' · ') }
    }
    return out
  }, [members, tasks])
  const full = members.length >= MAX_MEMBERS

  return (
    <div className="team">
      <BacklogDrop />
      {members.length === 0 ? (
        <Empty icon="users" title="아직 팀원이 없어요" hint="팀원을 추가하면 사무실 책상에 앉아요." />
      ) : (
        members.map((m) => <MemberCard key={m.id} memberId={m.id} stat={stats[m.id]} level={signals[m.id]?.level ?? 'ok'} reasons={signals[m.id]?.reasons ?? ''} />)
      )}
      <button
        type="button"
        className="btn btn-dashed"
        disabled={full}
        onClick={() => useOffice.getState().openDialog({ kind: 'member' })}
        title={full ? `자리가 가득 찼어요 (최대 ${MAX_MEMBERS}명)` : undefined}
      >
        <Icon name="plus" size={15} />
        팀원 추가
      </button>
      {full && <p className="hint-text">자리가 가득 찼어요 (최대 {MAX_MEMBERS}명). 팀원을 내보내면 다시 추가할 수 있어요.</p>}
    </div>
  )
}
