// Modal dialogs: task / member forms, remove member, confirms. OWNER: ui-builder.
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import type { Estimate, Id, MemberInput, MemberPatch, Priority, Reassign, TaskInput, TaskPatch, TaskStatus } from '../data/types'
import { ESTIMATES, MEMBER_COLORS, PRIORITIES, PRIORITY_META, STATUSES, STATUS_META } from '../data/meta'
import { OFFICE, MAX_MEMBERS } from '../office/layout'
import { taskKey, tasksOf, workload } from '../data/selectors'
import { useOffice, type Dialog } from '../store'
import { Field } from './common'
import { cssVars } from './format'
import { useMemberList, useProjectList } from './hooks'
import { Icon } from './icons'
import { EndMeetingDialog, MeetingHistoryDialog, StartMeetingDialog } from './MeetingDialogs'
import { useUi } from './uiState'

const FOCUSABLE = 'input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled]),[tabindex]:not([tabindex="-1"])'

export function Modal({ title, onClose, children, width = 460 }: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const el = ref.current
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus()
    if (first instanceof HTMLInputElement && first.type === 'text') first.select()
    return () => prev?.focus?.()
  }, [])

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === 'Tab' && ref.current) {
      const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ width }} onKeyDown={onKeyDown}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="btn btn-icon btn-ghost" aria-label="닫기" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </header>
        {children}
      </div>
    </div>
  )
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string
  message: ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void | Promise<void>
  onCancel: () => void
}) {
  const [busy, setBusy] = useState(false)
  return (
    <Modal title={title} onClose={onCancel} width={400}>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (busy) return
          setBusy(true)
          try {
            await onConfirm()
          } finally {
            setBusy(false)
          }
        }}
      >
        <div className="modal-body">
          <p className="modal-text">{message}</p>
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onCancel}>
            취소
          </button>
          <button type="submit" className={`btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`} data-autofocus disabled={busy}>
            {confirmLabel}
          </button>
        </footer>
      </form>
    </Modal>
  )
}

function close() {
  useOffice.getState().openDialog(null)
}

// ---- Task create / edit ------------------------------------------------------

interface TaskForm {
  title: string
  description: string
  projectId: Id
  status: TaskStatus
  priority: Priority
  estimate: Estimate
  assigneeId: string
  dueDate: string
}

function TaskDialog({ taskId, defaults }: { taskId?: Id; defaults?: Partial<TaskInput> }) {
  const existing = useOffice((s) => (taskId ? s.tasks[taskId] : undefined))
  const projects = useProjectList()
  const members = useMemberList()
  const projectKey = useOffice((s) => s.projects[existing?.projectId ?? '']?.key)
  const editing = !!taskId

  useEffect(() => {
    if (taskId && !existing) close()
  }, [taskId, existing])

  // Captured once when the dialog opens: edits are diffed against this, not the live task.
  const [initial] = useState<TaskForm>(() => {
    const base = existing ?? defaults
    return {
      title: base?.title ?? '',
      description: base?.description ?? '',
      projectId: base?.projectId ?? projects[0]?.id ?? '',
      status: base?.status ?? 'todo',
      priority: base?.priority ?? 'medium',
      estimate: base?.estimate ?? 3,
      assigneeId: base?.assigneeId ?? '',
      dueDate: base?.dueDate ?? '',
    }
  })
  const [form, setForm] = useState<TaskForm>(initial)
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof TaskForm>(k: K, v: TaskForm[K]) => setForm((f) => ({ ...f, [k]: v }))

  const title = form.title.trim()
  const titleError = title === '' ? '제목을 입력해 주세요' : title.length > 120 ? '제목은 120자 이하로 써 주세요' : ''
  const projectError = form.projectId === '' ? '프로젝트가 필요해요' : ''

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitted(true)
    if (titleError || projectError || busy) return
    setBusy(true)
    const st = useOffice.getState()
    if (editing && existing) {
      const patch: TaskPatch = {}
      if (title !== initial.title.trim()) patch.title = title
      if (form.description !== initial.description) patch.description = form.description
      if (form.projectId !== initial.projectId) patch.projectId = form.projectId
      if (form.status !== initial.status) patch.status = form.status
      if (form.priority !== initial.priority) patch.priority = form.priority
      if (form.estimate !== initial.estimate) patch.estimate = form.estimate
      if (form.dueDate !== initial.dueDate) patch.dueDate = form.dueDate || null
      let ok = true
      if (form.assigneeId !== initial.assigneeId) ok = await st.assignTask(existing.id, form.assigneeId || null)
      if (ok && Object.keys(patch).length > 0) ok = await st.updateTask(existing.id, patch)
      if (ok) {
        st.toast('good', '작업을 수정했어요')
        close()
      } else {
        setBusy(false)
      }
      return
    }
    const input: TaskInput = {
      title,
      projectId: form.projectId,
      description: form.description,
      status: form.status,
      priority: form.priority,
      estimate: form.estimate,
      // A member removed while the dialog was open (e.g. by a snapshot) must not be sent as assignee.
      assigneeId: form.assigneeId && members.some((m) => m.id === form.assigneeId) ? form.assigneeId : null,
      dueDate: form.dueDate || null,
    }
    const created = await st.createTask(input)
    if (created) {
      st.toast('good', '작업을 만들었어요')
      close()
    } else {
      setBusy(false)
    }
  }

  return (
    <Modal title={editing ? `작업 수정${existing ? ` · ${taskKey(existing, projectKey)}` : ''}` : '새 작업'} onClose={close} width={520}>
      <form onSubmit={submit} noValidate>
        <div className="modal-body">
          <Field label="제목" error={submitted || title.length > 120 ? titleError : ''}>
            <input
              className="select"
              type="text"
              data-autofocus
              value={form.title}
              maxLength={160}
              placeholder="무엇을 해야 하나요?"
              onChange={(e) => set('title', e.target.value)}
            />
          </Field>
          <Field label="설명">
            <textarea className="select" rows={3} value={form.description} placeholder="자세한 내용 (선택)" onChange={(e) => set('description', e.target.value)} />
          </Field>
          <div className="grid2">
            <Field label="프로젝트" error={submitted ? projectError : ''}>
              <select className="select" value={form.projectId} onChange={(e) => set('projectId', e.target.value)}>
                {projects.length === 0 && <option value="">프로젝트 없음</option>}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.key} · {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="담당자">
              <select className="select" value={form.assigneeId} onChange={(e) => set('assigneeId', e.target.value)}>
                <option value="">미배정</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="상태">
              <select className="select" value={form.status} onChange={(e) => set('status', e.target.value as TaskStatus)}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_META[s].label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="우선순위">
              <select className="select" value={form.priority} onChange={(e) => set('priority', e.target.value as Priority)}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_META[p].label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="예상 포인트">
              <select className="select" value={form.estimate} onChange={(e) => set('estimate', Number(e.target.value) as Estimate)}>
                {ESTIMATES.map((n) => (
                  <option key={n} value={n}>
                    {n}pt
                  </option>
                ))}
              </select>
            </Field>
            <Field label="마감일">
              <input className="select" type="date" value={form.dueDate} onChange={(e) => set('dueDate', e.target.value)} />
            </Field>
          </div>
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={close}>
            취소
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {editing ? '저장' : '만들기'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}

// ---- Member create / edit ----------------------------------------------------

function MemberDialog({ memberId }: { memberId?: Id }) {
  const members = useOffice((s) => s.members)
  const existing = memberId ? members[memberId] : undefined
  const editing = !!memberId
  const count = Object.keys(members).length
  const full = !editing && count >= MAX_MEMBERS

  useEffect(() => {
    if (memberId && !existing) close()
  }, [memberId, existing])

  const freeDesks = useMemo(() => {
    const used = new Set(Object.values(members).map((m) => m.deskId))
    return OFFICE.desks.filter((d) => !used.has(d.id) || d.id === existing?.deskId)
  }, [members, existing])

  const [initial] = useState(() => {
    const usedColors = new Set(Object.values(members).map((m) => m.color))
    return {
      name: existing?.name ?? '',
      role: existing?.role ?? '',
      color: existing?.color ?? MEMBER_COLORS.find((c) => !usedColors.has(c)) ?? MEMBER_COLORS[0],
      capacity: String(existing?.capacity ?? 10),
      deskId: existing?.deskId ?? '',
    }
  })
  const [form, setForm] = useState(initial)
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }))

  const name = form.name.trim()
  const nameError = name === '' ? '이름을 입력해 주세요' : name.length > 30 ? '이름은 30자 이하로 써 주세요' : ''
  const cap = Number(form.capacity)
  const capError = form.capacity.trim() === '' || !Number.isInteger(cap) || cap < 1 || cap > 40 ? '1~40 사이의 정수로 입력해 주세요' : ''

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitted(true)
    if (nameError || capError || full || busy) return
    setBusy(true)
    const st = useOffice.getState()
    if (editing && existing) {
      const patch: MemberPatch = {}
      if (name !== initial.name.trim()) patch.name = name
      if (form.role.trim() !== initial.role.trim()) patch.role = form.role.trim()
      if (form.color !== initial.color) patch.color = form.color
      if (cap !== Number(initial.capacity)) patch.capacity = cap
      if (form.deskId && form.deskId !== initial.deskId) patch.deskId = form.deskId
      const ok = Object.keys(patch).length === 0 ? true : await st.updateMember(existing.id, patch)
      if (ok) {
        st.toast('good', '팀원 정보를 수정했어요')
        close()
      } else {
        setBusy(false)
      }
      return
    }
    const input: MemberInput = { name, role: form.role.trim(), color: form.color, capacity: cap }
    if (form.deskId) input.deskId = form.deskId
    const created = await st.createMember(input)
    if (created) {
      st.toast('good', '팀원을 추가했어요')
      close()
    } else {
      setBusy(false)
    }
  }

  return (
    <Modal title={editing ? '팀원 편집' : '새 팀원'} onClose={close} width={480}>
      <form onSubmit={submit} noValidate>
        <div className="modal-body">
          {full && <p className="notice notice-warn">자리가 가득 찼어요 (최대 {MAX_MEMBERS}명). 팀원을 내보낸 뒤 다시 추가해 주세요.</p>}
          <div className="grid2">
            <Field label="이름" error={submitted || name.length > 30 ? nameError : ''}>
              <input className="select" type="text" data-autofocus value={form.name} maxLength={40} placeholder="예: 김하늘" onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="역할">
              <input className="select" type="text" value={form.role} maxLength={30} placeholder="예: 프론트엔드" onChange={(e) => set('role', e.target.value)} />
            </Field>
          </div>
          <div className="fld">
            <span className="fld-label">색</span>
            <div className="swatches" role="radiogroup" aria-label="색">
              {MEMBER_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={form.color === c}
                  aria-label={c}
                  className={`swatch${form.color === c ? ' is-on' : ''}`}
                  style={cssVars({ '--c': c })}
                  onClick={() => set('color', c)}
                >
                  {form.color === c && <Icon name="check" size={13} strokeWidth={3} />}
                </button>
              ))}
            </div>
          </div>
          <div className="grid2">
            <Field label="주간 여유량 (pt)" error={submitted ? capError : ''}>
              <input className="select" type="number" min={1} max={40} step={1} value={form.capacity} onChange={(e) => set('capacity', e.target.value)} />
            </Field>
            <Field label="책상">
              <select className="select" value={form.deskId} onChange={(e) => set('deskId', e.target.value)}>
                {!editing && <option value="">자동 배정</option>}
                {freeDesks.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.id} · {d.pod} 구역
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={close}>
            취소
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || full}>
            {editing ? '저장' : '추가'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}

// ---- Remove member -----------------------------------------------------------

function RemoveMemberDialog({ memberId }: { memberId: Id }) {
  const member = useOffice((s) => s.members[memberId])
  const tasks = useOffice((s) => s.tasks)
  const members = useMemberList()
  const others = useMemo(() => members.filter((m) => m.id !== memberId), [members, memberId])
  const openCount = useMemo(() => tasksOf(tasks, memberId).length, [tasks, memberId])
  const lightest = useMemo(() => {
    if (others.length === 0) return ''
    return others.reduce((a, b) => (workload(b, tasks) < workload(a, tasks) ? b : a)).id
  }, [others, tasks])

  const [mode, setMode] = useState<'backlog' | 'member'>('backlog')
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const targetId = target || lightest

  useEffect(() => {
    if (!member) close()
  }, [member])

  if (!member) return null

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    const reassign: Reassign = mode === 'member' && targetId ? { mode: 'member', memberId: targetId } : { mode: 'backlog' }
    const st = useOffice.getState()
    const ok = await st.deleteMember(memberId, reassign)
    if (ok) {
      st.toast('info', `${member.name} 님을 내보냈어요`)
      close()
    } else {
      setBusy(false)
    }
  }

  return (
    <Modal title={`${member.name} 님을 내보낼까요?`} onClose={close} width={460}>
      <form onSubmit={submit}>
        <div className="modal-body">
          {openCount === 0 ? (
            <p className="modal-text">남은 작업이 없어요. 책상이 비워져요.</p>
          ) : (
            <>
              <p className="modal-text">
                <strong>남은 작업 {openCount}개를 어떻게 할까요?</strong>
              </p>
              <label className={`radio${mode === 'backlog' ? ' is-on' : ''}`}>
                <input type="radio" name="reassign" checked={mode === 'backlog'} onChange={() => setMode('backlog')} data-autofocus />
                <span>
                  <b>백로그로 보내기</b>
                  <small>미배정 작업으로 돌아가요.</small>
                </span>
              </label>
              <label className={`radio${mode === 'member' ? ' is-on' : ''}${others.length === 0 ? ' is-disabled' : ''}`}>
                <input type="radio" name="reassign" checked={mode === 'member'} disabled={others.length === 0} onChange={() => setMode('member')} />
                <span>
                  <b>다른 팀원에게 넘기기</b>
                  <small>{others.length === 0 ? '넘길 팀원이 없어요.' : '선택한 팀원의 작업 목록에 추가돼요.'}</small>
                  {mode === 'member' && others.length > 0 && (
                    <select className="select" value={targetId} onChange={(e) => setTarget(e.target.value)} aria-label="받을 팀원">
                      {others.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                          {m.role ? ` · ${m.role}` : ''}
                        </option>
                      ))}
                    </select>
                  )}
                </span>
              </label>
            </>
          )}
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={close}>
            취소
          </button>
          <button type="submit" className="btn btn-danger-solid" disabled={busy} data-autofocus={openCount === 0 ? true : undefined}>
            내보내기
          </button>
        </footer>
      </form>
    </Modal>
  )
}

// ---- Delete task -------------------------------------------------------------

function DeleteTaskDialog({ taskId }: { taskId: Id }) {
  const task = useOffice((s) => s.tasks[taskId])
  const projectKey = useOffice((s) => s.projects[s.tasks[taskId]?.projectId ?? '']?.key)
  useEffect(() => {
    if (!task) close()
  }, [task])
  if (!task) return null
  return (
    <ConfirmDialog
      title="작업을 삭제할까요?"
      message={
        <>
          <b>
            {taskKey(task, projectKey)} · {task.title}
          </b>
          <br />이 작업은 되돌릴 수 없어요.
        </>
      }
      confirmLabel="삭제"
      danger
      onCancel={close}
      onConfirm={async () => {
        const st = useOffice.getState()
        if (await st.deleteTask(taskId)) {
          st.toast('info', '작업을 삭제했어요')
          close()
        }
      }}
    />
  )
}

function ResetDialog() {
  return (
    <ConfirmDialog
      title="데이터를 초기화할까요?"
      message="작업과 팀원이 처음 상태로 돌아가요. 이 작업은 되돌릴 수 없어요."
      confirmLabel="초기화"
      danger
      onCancel={close}
      onConfirm={async () => {
        const st = useOffice.getState()
        if (await st.resetData()) {
          st.toast('good', '데이터를 초기화했어요')
          close()
        }
      }}
    />
  )
}

export function Dialogs() {
  const dialog = useOffice((s) => s.dialog)
  const historyOpen = useUi((s) => s.historyOpen)
  return (
    <>
      {dialog && <DialogSwitch key={dialogKey(dialog)} dialog={dialog} />}
      {historyOpen && !dialog && <MeetingHistoryDialog />}
    </>
  )
}

function dialogKey(d: Dialog): string {
  return JSON.stringify(d)
}

function DialogSwitch({ dialog }: { dialog: Dialog }) {
  switch (dialog.kind) {
    case 'task':
      return <TaskDialog taskId={dialog.taskId} defaults={dialog.defaults} />
    case 'member':
      return <MemberDialog memberId={dialog.memberId} />
    case 'removeMember':
      return <RemoveMemberDialog memberId={dialog.memberId} />
    case 'deleteTask':
      return <DeleteTaskDialog taskId={dialog.taskId} />
    case 'confirmReset':
      return <ResetDialog />
    case 'startMeeting':
      return <StartMeetingDialog />
    case 'endMeeting':
      return <EndMeetingDialog meetingId={dialog.meetingId} />
  }
}
