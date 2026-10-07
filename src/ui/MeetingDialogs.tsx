// Meeting dialogs: start, end (decide per agenda task) and the read-only minutes list. OWNER: ui-builder.
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { AgendaOutcome, Id, Meeting, Member, TaskStatus } from '../data/types'
import { STATUSES, STATUS_META } from '../data/meta'
import { taskKey } from '../data/selectors'
import { ongoingMeeting, useOffice } from '../store'
import { Avatar, AssigneeChip, Empty, Field, PriorityDot } from './common'
import { Modal } from './Dialogs'
import { cssVars, formatClock, formatDate, formatDuration, localDateOf } from './format'
import { useAgendaTasks, useMemberList } from './hooks'
import { Icon } from './icons'
import { useUi } from './uiState'

function close() {
  useOffice.getState().openDialog(null)
}

// ---- Start -------------------------------------------------------------------

export function StartMeetingDialog() {
  const members = useMemberList()
  const projects = useOffice((s) => s.projects)
  const live = useOffice((s) => ongoingMeeting(s.meetings))
  const agenda = useAgendaTasks()
  const [title, setTitle] = useState('팀 회의')
  // Away / on-break members are shown but not pre-selected.
  const [picked, setPicked] = useState<Set<Id>>(() => new Set(members.filter((m) => m.presence === 'working' || m.presence === 'meeting').map((m) => m.id)))
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (live) close()
  }, [live])

  const name = title.trim()
  const titleError = name === '' ? '회의 이름을 입력해 주세요' : name.length > 60 ? '이름은 60자 이하로 써 주세요' : ''
  const attendeeIds = members.filter((m) => picked.has(m.id)).map((m) => m.id)
  const attendeeError = attendeeIds.length === 0 ? '참석자를 한 명 이상 골라 주세요' : ''
  const allOn = members.length > 0 && attendeeIds.length === members.length

  const toggle = (id: Id) =>
    setPicked((p) => {
      const next = new Set(p)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitted(true)
    if (titleError || attendeeError || busy) return
    setBusy(true)
    const st = useOffice.getState()
    const meeting = await st.startMeeting({ title: name, attendeeIds })
    if (meeting) {
      st.toast('good', '회의를 시작했어요')
      close()
    } else {
      setBusy(false)
    }
  }

  return (
    <Modal title="회의 시작" onClose={close} width={520}>
      <form onSubmit={submit} noValidate>
        <div className="modal-body">
          <Field label="회의 이름" error={submitted || name.length > 60 ? titleError : ''}>
            <input className="select" type="text" data-autofocus value={title} maxLength={80} placeholder="예: 주간 싱크" onChange={(e) => setTitle(e.target.value)} />
          </Field>

          <div className="fld">
            <div className="fld-row">
              <span className="fld-label">참석자 {attendeeIds.length}/{members.length}명</span>
              {members.length > 0 && (
                <button type="button" className="link-btn" onClick={() => setPicked(allOn ? new Set() : new Set(members.map((m) => m.id)))}>
                  {allOn ? '모두 해제' : '모두 선택'}
                </button>
              )}
            </div>
            {members.length === 0 ? (
              <p className="dim small">팀원이 없어요. 팀원을 먼저 추가해 주세요.</p>
            ) : (
              <div className="fchips" role="group" aria-label="참석자">
                {members.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    aria-pressed={picked.has(m.id)}
                    className={`fchip fchip-lg${picked.has(m.id) ? ' is-on' : ''}${m.presence === 'away' ? ' is-away' : ''}`}
                    style={cssVars({ '--c': m.color })}
                    title={m.presence === 'working' ? m.role : `${m.role ? `${m.role} · ` : ''}${m.presence === 'away' ? '자리 비움' : m.presence === 'break' ? '휴식 중' : '회의 중'}`}
                    onClick={() => toggle(m.id)}
                  >
                    <Avatar member={m} size={16} />
                    {m.name}
                    {m.presence === 'away' && <span className="chip-note">자리 비움</span>}
                  </button>
                ))}
              </div>
            )}
            {submitted && attendeeError && <em className="fld-error">{attendeeError}</em>}
          </div>

          <div className="fld">
            <span className="fld-label">안건 {agenda.length}개 · 우선순위 순</span>
            {agenda.length === 0 ? (
              <p className="agenda-empty">아직 안건이 없어요.</p>
            ) : (
              <ul className="agenda-list">
                {agenda.map((t) => (
                  <li key={t.id}>
                    <PriorityDot priority={t.priority} />
                    <span className="card-key">{taskKey(t, projects[t.projectId]?.key)}</span>
                    <span className="mini-title" title={t.title}>
                      {t.title}
                    </span>
                    <AssigneeChip memberId={t.assigneeId} showName={false} />
                    <button
                      type="button"
                      className="btn btn-icon btn-ghost btn-xs"
                      aria-label={`${t.title} 안건에서 내리기`}
                      title="안건에서 내리기"
                      onClick={() => void useOffice.getState().setAgenda(t.id, false)}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="dim small">작업 상자를 회의실 테이블로 끌어다 놓으면 안건이 돼요</p>
          </div>
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={close}>
            취소
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || members.length === 0}>
            회의 시작
          </button>
        </footer>
      </form>
    </Modal>
  )
}

// ---- End ---------------------------------------------------------------------

type Choice = 'keep' | 'assign' | 'status' | 'backlog'

interface Decision {
  pick: Choice
  /** '' = not chosen yet (placeholder). */
  memberId: string
  /** '' = not chosen yet (placeholder). */
  status: TaskStatus | ''
}

const PICKS: { id: Choice; label: string }[] = [
  { id: 'keep', label: '보류' },
  { id: 'assign', label: '담당 지정' },
  { id: 'status', label: '상태 변경' },
  { id: 'backlog', label: '백로그로' },
]

export function EndMeetingDialog({ meetingId }: { meetingId: Id }) {
  const meeting = useOffice((s) => s.meetings[meetingId])
  const tasks = useOffice((s) => s.tasks)
  const projects = useOffice((s) => s.projects)
  const members = useMemberList()
  const [notes, setNotes] = useState('')
  const [decisions, setDecisions] = useState<Record<Id, Partial<Decision>>>({})
  const [busy, setBusy] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  /** True while our own endMeeting call is in flight, so its store update isn't mistaken for "ended elsewhere". */
  const endingHere = useRef(false)

  const ongoing = meeting?.status === 'ongoing'
  useEffect(() => {
    if (ongoing) return
    if (!endingHere.current) useOffice.getState().toast('info', '다른 곳에서 회의가 끝났어요')
    close()
  }, [ongoing])

  const rows = useMemo(() => (meeting ? meeting.agendaTaskIds.map((id) => tasks[id]).filter((t) => !!t) : []), [meeting, tasks])

  if (!meeting) return null

  const resolve = (taskId: Id): Decision => {
    const d = decisions[taskId] ?? {}
    return { pick: d.pick ?? 'keep', memberId: d.memberId ?? '', status: d.status ?? '' }
  }
  const patch = (taskId: Id, p: Partial<Decision>) => setDecisions((d) => ({ ...d, [taskId]: { ...d[taskId], ...p } }))

  // A pick only counts as a decision once it differs from what the task already has.
  const outcomes: AgendaOutcome[] = []
  const errors: Record<Id, string> = {}
  for (const t of rows) {
    const d = resolve(t.id)
    if (d.pick === 'assign') {
      if (d.memberId && !members.some((m) => m.id === d.memberId)) errors[t.id] = '선택한 팀원이 더 이상 없어요. 다시 골라 주세요'
      else if (d.memberId && d.memberId !== t.assigneeId) outcomes.push({ taskId: t.id, action: 'assign', memberId: d.memberId })
    } else if (d.pick === 'status') {
      if (d.status && d.status !== t.status) outcomes.push({ taskId: t.id, action: 'status', status: d.status })
    } else if (d.pick === 'backlog') {
      outcomes.push({ taskId: t.id, action: 'backlog' })
    }
  }
  const hasError = Object.keys(errors).length > 0

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitted(true)
    if (busy || hasError) return
    setBusy(true)
    endingHere.current = true
    const st = useOffice.getState()
    const ok = await st.endMeeting(meeting.id, { notes: notes.trim(), outcomes })
    if (ok) {
      st.toast('good', outcomes.length > 0 ? `회의를 마쳤어요 · 결정 ${outcomes.length}건 적용` : '회의를 마쳤어요')
      close()
    } else {
      endingHere.current = false
      setBusy(false)
    }
  }

  return (
    <Modal title={`회의 종료 · ${meeting.title}`} onClose={close} width={580}>
      <form onSubmit={submit}>
        <div className="modal-body">
          {rows.length === 0 ? (
            <p className="agenda-empty">안건이 없었어요. 메모만 남기고 마칠 수 있어요.</p>
          ) : (
            <ul className="outcomes">
              {rows.map((t) => {
                const d = resolve(t.id)
                const same = (d.pick === 'assign' && d.memberId !== '' && d.memberId === t.assigneeId) || (d.pick === 'status' && d.status !== '' && d.status === t.status)
                return (
                  <li key={t.id} className="outcome">
                    <div className="outcome-top">
                      <PriorityDot priority={t.priority} />
                      <span className="card-key">{taskKey(t, projects[t.projectId]?.key)}</span>
                      <span className="mini-title" title={t.title}>
                        {t.title}
                      </span>
                      <AssigneeChip memberId={t.assigneeId} />
                    </div>
                    <div className="outcome-ctl">
                      <div className="seg" role="radiogroup" aria-label={`${t.title} 결정`}>
                        {PICKS.map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            role="radio"
                            aria-checked={d.pick === p.id}
                            className={d.pick === p.id ? 'is-on' : ''}
                            onClick={() => patch(t.id, { pick: p.id })}
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                      {d.pick === 'assign' && (
                        <select
                          className={`select select-sm${errors[t.id] ? ' is-invalid' : ''}`}
                          aria-label="담당자"
                          aria-invalid={!!errors[t.id]}
                          value={members.some((m) => m.id === d.memberId) ? d.memberId : ''}
                          onChange={(e) => patch(t.id, { memberId: e.target.value })}
                        >
                          <option value="">담당자 선택</option>
                          {members.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                      )}
                      {d.pick === 'status' && (
                        <select className="select select-sm" aria-label="상태" value={d.status} onChange={(e) => patch(t.id, { status: e.target.value as TaskStatus })}>
                          <option value="">상태 선택</option>
                          {STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {STATUS_META[s].label}
                            </option>
                          ))}
                        </select>
                      )}
                      {same && <span className="dim small">지금과 같아서 결정으로 세지 않아요</span>}
                    </div>
                    {errors[t.id] && (
                      <em className="fld-error" role="alert">
                        {errors[t.id]}
                      </em>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          <Field label="회의 메모">
            <textarea className="select" rows={3} value={notes} maxLength={2000} placeholder="결정 배경이나 다음 할 일을 남겨 보세요 (선택)" onChange={(e) => setNotes(e.target.value)} />
          </Field>
          {submitted && hasError && <p className="notice notice-warn">담당자를 다시 골라 주세요.</p>}
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={close}>
            취소
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || hasError} data-autofocus>
            {outcomes.length > 0 ? `회의 종료 · 결정 ${outcomes.length}건 적용` : '회의 종료'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}

// ---- History (read-only) -----------------------------------------------------

function outcomeText(o: AgendaOutcome, members: Record<Id, Member>): string {
  switch (o.action) {
    case 'assign':
      return `${members[o.memberId]?.name ?? '팀원'} 님에게 배정`
    case 'status':
      return `${STATUS_META[o.status].label}(으)로 변경`
    case 'backlog':
      return '백로그로 이동'
    case 'keep':
      return '보류'
  }
}

function MeetingRecord({ meeting }: { meeting: Meeting }) {
  const members = useOffice((s) => s.members)
  const tasks = useOffice((s) => s.tasks)
  const projects = useOffice((s) => s.projects)
  const decided = meeting.outcomes.filter((o) => o.action !== 'keep')
  const kept = meeting.agendaTaskIds.length - decided.length
  const who = meeting.attendeeIds.map((id) => members[id]).filter((m) => !!m)
  return (
    <li className="minutes">
      <div className="minutes-head">
        <strong>{meeting.title}</strong>
        <span className="dim">
          {formatDate(localDateOf(meeting.startedAt))} · {formatClock(meeting.startedAt)} · {formatDuration(meeting.startedAt, meeting.endedAt)}
        </span>
      </div>
      <div className="minutes-who">
        {who.length === 0 ? (
          <span className="dim small">참석자 {meeting.attendeeIds.length}명</span>
        ) : (
          who.map((m) => (
            <span key={m.id} className="fchip is-on" style={cssVars({ '--c': m.color })}>
              <Avatar member={m} size={14} />
              {m.name}
            </span>
          ))
        )}
      </div>
      <div className="small dim">
        안건 {meeting.agendaTaskIds.length}개{decided.length > 0 ? ` · 결정 ${decided.length}건` : ''}
        {kept > 0 ? ` · 보류 ${kept}건` : ''}
      </div>
      {decided.length > 0 && (
        <ul className="minutes-decisions">
          {decided.map((o) => {
            const t = tasks[o.taskId]
            return (
              <li key={o.taskId}>
                <span className="card-key">{t ? taskKey(t, projects[t.projectId]?.key) : '삭제됨'}</span>
                <span className="mini-title">{t?.title ?? '삭제된 작업'}</span>
                <span className="dim">{outcomeText(o, members)}</span>
              </li>
            )
          })}
        </ul>
      )}
      {meeting.notes.trim() !== '' && <p className="minutes-notes">{meeting.notes}</p>}
    </li>
  )
}

export function MeetingHistoryDialog() {
  const meetings = useOffice((s) => s.meetings)
  const ended = useMemo(
    () =>
      Object.values(meetings)
        .filter((m) => m.status === 'ended')
        .sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt))
        .slice(0, 10),
    [meetings],
  )
  const onClose = () => useUi.getState().setHistoryOpen(false)
  return (
    <Modal title="회의록" onClose={onClose} width={560}>
      <div className="modal-body">
        {ended.length === 0 ? (
          <Empty icon="meeting" title="아직 회의록이 없어요" hint="회의를 시작하고 마치면 여기에 기록돼요." />
        ) : (
          <ul className="minutes-list">
            {ended.map((m) => (
              <MeetingRecord key={m.id} meeting={m} />
            ))}
          </ul>
        )}
      </div>
      <footer className="modal-foot">
        <button type="button" className="btn" data-autofocus onClick={onClose}>
          닫기
        </button>
      </footer>
    </Modal>
  )
}
