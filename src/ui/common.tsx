// Small shared presentational pieces. OWNER: ui-builder.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Id, Member, Presence, Priority } from '../data/types'
import { PRESENCE_META, PRIORITY_META } from '../data/meta'
import { SIGNAL_META, type SignalLevel } from '../data/insights'
import { useOffice } from '../store'
import { Icon, type IconName } from './icons'
import { cssVars, initialOf } from './format'

export function Avatar({ member, size = 22 }: { member?: Member; size?: number }) {
  if (!member) {
    return (
      <span className="avatar avatar-none" style={cssVars({ '--sz': `${size}px` })} title="미배정">
        <Icon name="user" size={Math.round(size * 0.6)} />
      </span>
    )
  }
  return (
    <span className="avatar" style={cssVars({ '--sz': `${size}px`, '--c': member.color })} title={member.name}>
      {initialOf(member.name)}
    </span>
  )
}

/** Avatar + name of a member id, or a dashed "미배정" chip. Subscribes to just that member. */
export function AssigneeChip({ memberId, showName = true }: { memberId: Id | null; showName?: boolean }) {
  const member = useOffice((s) => (memberId ? s.members[memberId] : undefined))
  if (!memberId || !member) {
    return (
      <span className="assignee assignee-none" title="미배정">
        <Avatar size={20} />
        {showName && <span>미배정</span>}
      </span>
    )
  }
  return (
    <span className="assignee" title={member.name}>
      <Avatar member={member} size={20} />
      {showName && <span className="assignee-name">{member.name}</span>}
    </span>
  )
}

export function PriorityDot({ priority, withLabel = false }: { priority: Priority; withLabel?: boolean }) {
  const m = PRIORITY_META[priority]
  return (
    <span className="prio" title={`우선순위 ${m.label}`}>
      <i className="dot" style={cssVars({ '--c': m.color })} />
      {withLabel && <span>{m.label}</span>}
    </span>
  )
}

export function ProjectTag({ projectId }: { projectId: Id }) {
  const project = useOffice((s) => s.projects[projectId])
  if (!project) return null
  return (
    <span className="ptag" title={project.name}>
      <i className="dot" style={cssVars({ '--c': project.color })} />
      {project.key}
    </span>
  )
}

export function PresencePill({ presence }: { presence: Presence }) {
  const m = PRESENCE_META[presence]
  return (
    <span className="presence" style={cssVars({ '--c': m.color })}>
      <i className="dot" />
      {m.label}
    </span>
  )
}

export function Empty({ icon = 'inbox', title, hint, action }: { icon?: IconName; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={22} />
      </span>
      <strong>{title}</strong>
      {hint && <span className="empty-hint">{hint}</span>}
      {action}
    </div>
  )
}

/** Number that eases to its new value. */
export function AnimatedNumber({ value, duration = 450 }: { value: number; duration?: number }) {
  const [shown, setShown] = useState(value)
  const from = useRef(value)
  const shownRef = useRef(value)
  useEffect(() => {
    from.current = shownRef.current
    if (from.current === value) return
    const start = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - p, 3)
      const v = Math.round(from.current + (value - from.current) * eased)
      shownRef.current = v
      setShown(v)
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, duration])
  return <>{shown}</>
}

/** Text that stays a native control but accepts only a labelled wrapper. */
export function Field({ label, error, children, className }: { label: string; error?: string; children: ReactNode; className?: string }) {
  return (
    <label className={`fld ${className ?? ''}`}>
      <span className="fld-label">{label}</span>
      {children}
      {error && <em className="fld-error">{error}</em>}
    </label>
  )
}

/** Small status diamond (same signal as the one above the avatar in 3D). */
export function Diamond({ level, size = 10, title }: { level: SignalLevel; size?: number; title?: string }) {
  const m = SIGNAL_META[level]
  return (
    <svg className="diamond" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={title ?? m.label} style={{ color: m.color }}>
      <title>{title ?? m.label}</title>
      <path d="M12 1.5l9.5 10.5L12 22.5 2.5 12 12 1.5z" fill="currentColor" />
    </svg>
  )
}
