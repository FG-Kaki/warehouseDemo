// Detail drawer for the selected task or member. OWNER: ui-builder.
import { useMemo, useState } from 'react'
import type { Estimate, Id, Member, Priority, TaskStatus } from '../data/types'
import { memberSignal, memberVitals, SIGNAL_META } from '../data/insights'
import { ESTIMATES, PRIORITIES, PRIORITY_META, STATUSES, STATUS_META } from '../data/meta'
import { taskKey, tasksOf, workloadLevel } from '../data/selectors'
import { useOffice } from '../store'
import { Avatar, Diamond, PresencePill, PriorityDot, ProjectTag } from './common'
import { dueInfo, formatDate, relativeTime } from './format'
import { useMemberList, useNow, useProjectList } from './hooks'
import { Icon } from './icons'

/** Click-to-edit text that commits on blur / Enter and reverts on Esc. */
function InlineText({
  value,
  onCommit,
  multiline,
  maxLength,
  required,
  placeholder,
  className,
  label,
}: {
  value: string
  onCommit: (v: string) => void
  multiline?: boolean
  maxLength?: number
  required?: boolean
  placeholder?: string
  className?: string
  label: string
}) {
  const [draft, setDraft] = useState(value)
  const [focused, setFocused] = useState(false)
  const shown = focused ? draft : value
  const commit = () => {
    setFocused(false)
    const v = draft.trim()
    if (required && v === '') return
    if (v !== value) onCommit(v)
  }
  const common = {
    className: `inline ${className ?? ''}`,
    value: shown,
    maxLength,
    placeholder,
    'aria-label': label,
    onFocus: () => {
      setDraft(value)
      setFocused(true)
    },
    onBlur: commit,
  }
  return multiline ? (
    <textarea
      {...common}
      rows={3}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          setDraft(value)
          e.currentTarget.blur()
        }
      }}
    />
  ) : (
    <input
      {...common}
      type="text"
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') {
          e.stopPropagation()
          setDraft(value)
          e.currentTarget.blur()
        }
      }}
    />
  )
}

function CloseButton() {
  return (
    <button type="button" className="btn btn-icon btn-ghost" aria-label="상세 닫기 (Esc)" title="닫기 (Esc)" onClick={() => useOffice.getState().select(null)}>
      <Icon name="close" size={16} />
    </button>
  )
}

function TaskDetail({ taskId }: { taskId: Id }) {
  const task = useOffice((s) => s.tasks[taskId])
  const projectKey = useOffice((s) => s.projects[s.tasks[taskId]?.projectId ?? '']?.key)
  const projects = useProjectList()
  const members = useMemberList()
  const activity = useOffice((s) => s.activity)
  const now = useNow()
  const recent = useMemo(() => activity.filter((a) => a.taskId === taskId).slice(-4).reverse(), [activity, taskId])
  if (!task) return null
  const st = useOffice.getState()
  const due = dueInfo(task)

  return (
    <aside className="detail glass" aria-label="작업 상세">
      <div className="detail-head">
        <PriorityDot priority={task.priority} />
        <span className="detail-key">{taskKey(task, projectKey)}</span>
        <ProjectTag projectId={task.projectId} />
        {due && <span className={`due due-${due.tone}`}>{due.text}</span>}
        <span className="grow" />
        <CloseButton />
      </div>
      <div className="detail-body">
        <InlineText
          className="inline-title"
          label="제목"
          value={task.title}
          maxLength={120}
          required
          onCommit={(v) => void st.updateTask(taskId, { title: v })}
        />
        <div className="grid3">
          <label className="fld">
            <span className="fld-label">상태</span>
            <select className="select" value={task.status} onChange={(e) => void st.updateTask(taskId, { status: e.target.value as TaskStatus })}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_META[s].label}
                </option>
              ))}
            </select>
          </label>
          <label className="fld">
            <span className="fld-label">우선순위</span>
            <select className="select" value={task.priority} onChange={(e) => void st.updateTask(taskId, { priority: e.target.value as Priority })}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_META[p].label}
                </option>
              ))}
            </select>
          </label>
          <label className="fld">
            <span className="fld-label">예상 포인트</span>
            <select className="select" value={task.estimate} onChange={(e) => void st.updateTask(taskId, { estimate: Number(e.target.value) as Estimate })}>
              {ESTIMATES.map((n) => (
                <option key={n} value={n}>
                  {n}pt
                </option>
              ))}
            </select>
          </label>
          <label className="fld">
            <span className="fld-label">담당자</span>
            <select className="select" value={task.assigneeId ?? ''} onChange={(e) => void st.assignTask(taskId, e.target.value || null)}>
              <option value="">미배정</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="fld">
            <span className="fld-label">프로젝트</span>
            <select className="select" value={task.projectId} onChange={(e) => void st.updateTask(taskId, { projectId: e.target.value })}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="fld">
            <span className="fld-label">마감일</span>
            <input
              className="select"
              type="date"
              value={task.dueDate ?? ''}
              title={task.dueDate ? formatDate(task.dueDate) : '마감일 없음'}
              onChange={(e) => void st.updateTask(taskId, { dueDate: e.target.value || null })}
            />
          </label>
        </div>
        <div className="fld">
          <span className="fld-label">설명</span>
          <InlineText label="설명" multiline value={task.description} placeholder="설명을 추가해 보세요" onCommit={(v) => void st.updateTask(taskId, { description: v })} />
        </div>
        <div className="fld">
          <span className="fld-label">최근 활동</span>
          {recent.length === 0 ? (
            <p className="dim small">아직 기록이 없어요.</p>
          ) : (
            <ul className="mini-feed">
              {recent.map((a) => (
                <li key={a.id}>
                  <span>{a.message}</span>
                  <time>{relativeTime(a.at, now)}</time>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="detail-foot">
        <button type="button" className="btn btn-sm" onClick={() => st.focusOn({ kind: 'task', id: taskId })}>
          <Icon name="locate" size={14} />
          3D에서 보기
        </button>
        <span className="grow" />
        <button type="button" className="btn btn-sm btn-danger" onClick={() => st.openDialog({ kind: 'deleteTask', taskId })}>
          <Icon name="trash" size={14} />
          삭제
        </button>
      </div>
    </aside>
  )
}

const NEED_COLORS = { low: SIGNAL_META.ok.color, mid: SIGNAL_META.busy.color, high: SIGNAL_META.alert.color }

function Need({ label, value, ratio, color, title }: { label: string; value: string; ratio: number; color: string; title?: string }) {
  return (
    <div className="need" title={title}>
      <span className="need-label">{label}</span>
      <div className="need-bar" role="img" aria-label={`${label} ${value}`}>
        <i style={{ width: `${Math.max(0, Math.min(1, ratio)) * 100}%`, background: color }} />
      </div>
      <span className="need-value">{value}</span>
    </div>
  )
}

function pressureWord(p: number) {
  if (p >= 1) return '지연'
  if (p >= 0.6) return '높음'
  if (p >= 0.3) return '보통'
  return p > 0 ? '낮음' : '없음'
}

/** Sims-style status card: signal line + three needs gauges. */
function Vitals({ member }: { member: Member }) {
  const tasks = useOffice((s) => s.tasks)
  const signal = useMemo(() => memberSignal(member, tasks), [member, tasks])
  const v = useMemo(() => memberVitals(member, tasks), [member, tasks])
  const level = workloadLevel(v.workload)
  const pressureColor = v.deadlinePressure >= 0.6 ? NEED_COLORS.high : v.deadlinePressure >= 0.3 ? NEED_COLORS.mid : NEED_COLORS.low
  const focusColor = v.focus >= 0.7 ? NEED_COLORS.low : NEED_COLORS.mid
  const focusHint = v.inProgress === 0 ? '진행 중 없음' : `진행 중 ${v.inProgress}개`

  return (
    <div className="vitals">
      <div className="signal">
        <Diamond level={signal.level} size={12} />
        <strong style={{ color: SIGNAL_META[signal.level].color }}>{SIGNAL_META[signal.level].label}</strong>
        <span className="dim">{signal.reasons.length ? signal.reasons.join(' · ') : '특이사항 없음'}</span>
      </div>
      <Need
        label="업무량"
        value={`${Math.round(v.workload * 100)}%`}
        ratio={Math.min(v.workload, 1.5) / 1.5}
        color={level.color}
        title={`열린 작업 ${v.openPoints}/${member.capacity}pt · ${level.label}`}
      />
      <Need label="마감 압박" value={pressureWord(v.deadlinePressure)} ratio={v.deadlinePressure} color={pressureColor} />
      <Need label="집중도" value={focusHint} ratio={v.focus} color={focusColor} title="진행 중인 작업이 1개일 때 가장 높아요" />
    </div>
  )
}

function MemberDetail({ memberId }: { memberId: Id }) {
  const member = useOffice((s) => s.members[memberId])
  const tasks = useOffice((s) => s.tasks)
  const projects = useOffice((s) => s.projects)
  const open = useMemo(() => tasksOf(tasks, memberId).reverse(), [tasks, memberId])
  if (!member) return null
  const st = useOffice.getState()

  return (
    <aside className="detail glass" aria-label="팀원 상세">
      <div className="detail-head">
        <Avatar member={member} size={34} />
        <div className="detail-who">
          <strong>{member.name}</strong>
          <span className="dim">{member.role || '역할 없음'}</span>
        </div>
        <PresencePill presence={member.presence} />
        <span className="grow" />
        <CloseButton />
      </div>
      <div className="detail-body">
        <Vitals member={member} />
        <div className="fld">
          <span className="fld-label">열린 작업 {open.length}개</span>
          {open.length === 0 ? (
            <p className="dim small">맡은 작업이 없어요. 작업을 끌어다 책상에 놓아 보세요.</p>
          ) : (
            <ul className="mini-tasks">
              {open.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => st.select({ kind: 'task', id: t.id })}
                    onPointerEnter={() => st.setHover({ kind: 'task', id: t.id })}
                    onPointerLeave={() => st.setHover(null)}
                  >
                    <PriorityDot priority={t.priority} />
                    <span className="card-key">{taskKey(t, projects[t.projectId]?.key)}</span>
                    <span className="mini-title">{t.title}</span>
                    {dueInfoBadge(t)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="detail-foot">
        <button type="button" className="btn btn-sm" onClick={() => st.focusOn({ kind: 'member', id: memberId })}>
          <Icon name="locate" size={14} />
          3D에서 보기
        </button>
        <button type="button" className="btn btn-sm" onClick={() => st.openDialog({ kind: 'member', memberId })}>
          <Icon name="edit" size={14} />
          편집
        </button>
        <span className="grow" />
        <button type="button" className="btn btn-sm btn-danger" onClick={() => st.openDialog({ kind: 'removeMember', memberId })}>
          <Icon name="logout" size={14} />
          내보내기
        </button>
      </div>
    </aside>
  )
}

function dueInfoBadge(t: Parameters<typeof dueInfo>[0]) {
  const d = dueInfo(t)
  return d ? <span className={`due due-${d.tone}`}>{d.text}</span> : null
}

export function DetailDrawer() {
  const kind = useOffice((s) => s.selection?.kind ?? null)
  const id = useOffice((s) => s.selection?.id ?? null)
  const exists = useOffice((s) => {
    if (!s.selection) return false
    return s.selection.kind === 'task' ? !!s.tasks[s.selection.id] : !!s.members[s.selection.id]
  })
  if (!kind || !id || !exists) return null
  return kind === 'task' ? <TaskDetail key={id} taskId={id} /> : <MemberDetail key={id} memberId={id} />
}
