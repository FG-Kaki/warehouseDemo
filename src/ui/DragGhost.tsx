// Small card that follows the cursor while a task is being dragged. OWNER: ui-builder.
import { useEffect, useRef } from 'react'
import { STATUS_META } from '../data/meta'
import { taskKey } from '../data/selectors'
import { useOffice, type DropTarget } from '../store'
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

function hintFor(target: DropTarget | null, memberName: string | undefined): { text: string; ok: boolean } {
  if (!target) return { text: '놓을 곳을 찾는 중', ok: false }
  if (target.kind === 'member') return { text: `${memberName ?? '팀원'} 님에게 배정`, ok: true }
  if (target.kind === 'backlog') return { text: '백로그로 이동', ok: true }
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
  const memberName = useOffice((s) => (s.dropTarget?.kind === 'member' ? s.members[s.dropTarget.id]?.name : undefined))

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
  const hint = hintFor(target, memberName)
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
