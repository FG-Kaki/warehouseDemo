// Small card that follows the cursor while a task is being dragged. OWNER: ui-builder.
import { useEffect, useRef } from 'react'
import { STATUS_META } from '../data/meta'
import { taskKey } from '../data/selectors'
import { useOffice, type DropTarget } from '../store'
import { formatDate } from './format'
import { Icon } from './icons'

/** Last known pointer position, kept outside React so the ghost can start in the right place. */
const pointer = { x: -999, y: -999 }

export function useTrackPointer() {
  useEffect(() => {
    const move = (e: PointerEvent) => {
      pointer.x = e.clientX
      pointer.y = e.clientY
    }
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerdown', move, { passive: true })
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerdown', move)
    }
  }, [])
}

function hintFor(target: DropTarget | null, memberName: string | undefined, assigneeId: string | null): { text: string; ok: boolean } {
  if (!target) return { text: '놓을 곳을 찾는 중', ok: false }
  if (target.kind === 'member') return { text: `${memberName ?? '팀원'} 님에게 배정`, ok: true }
  if (target.kind === 'backlog') return { text: '백로그로 이동', ok: true }
  if (target.kind === 'agenda') return { text: '안건으로 올리기', ok: true }
  if (target.kind === 'day') {
    let text = `${formatDate(target.date)} 마감으로`
    if (target.memberId !== undefined && target.memberId !== assigneeId) {
      text += target.memberId === null ? ' · 미배정' : ` · ${memberName ?? '팀원'} 님`
    }
    return { text, ok: true }
  }
  const label = STATUS_META[target.status].label
  // Josa: a final consonant other than ㄹ takes "으로" ("진행 중으로"), otherwise "로".
  const code = label.charCodeAt(label.length - 1) - 0xac00
  const josa = code >= 0 && code % 28 !== 0 && code % 28 !== 8 ? '으로' : '로'
  return { text: `${label}${josa} 이동`, ok: true }
}

export function DragGhost() {
  const taskId = useOffice((s) => s.drag?.taskId ?? null)
  if (taskId === null) return null
  return <Ghost taskId={taskId} />
}

function Ghost({ taskId }: { taskId: string }) {
  const el = useRef<HTMLDivElement>(null)
  const task = useOffice((s) => s.tasks[taskId])
  const projectKey = useOffice((s) => s.projects[s.tasks[taskId]?.projectId ?? '']?.key)
  const target = useOffice((s) => s.dropTarget)
  const memberName = useOffice((s) => {
    const t = s.dropTarget
    if (t?.kind === 'member') return s.members[t.id]?.name
    if (t?.kind === 'day' && t.memberId) return s.members[t.memberId]?.name
    return undefined
  })

  useEffect(() => {
    const place = (x: number, y: number) => {
      if (el.current) el.current.style.transform = `translate3d(${x + 16}px, ${y + 14}px, 0)`
    }
    place(pointer.x, pointer.y)
    const move = (e: PointerEvent) => place(e.clientX, e.clientY)
    window.addEventListener('pointermove', move, { passive: true })
    return () => window.removeEventListener('pointermove', move)
  }, [])

  if (!task) return null
  const hint = hintFor(target, memberName, task.assigneeId)
  return (
    <div ref={el} className={`ghost${hint.ok ? ' is-ok' : ''}`}>
      <div className="ghost-key">{taskKey(task, projectKey)}</div>
      <div className="ghost-title">{task.title}</div>
      <div className="ghost-hint">
        <Icon name={hint.ok ? 'check' : 'locate'} size={12} />
        {hint.text}
      </div>
    </div>
  )
}
