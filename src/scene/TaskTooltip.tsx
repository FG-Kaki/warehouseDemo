// A small label that follows the hovered task box (not while dragging).
import { useFrame } from '@react-three/fiber'
import { useRef } from 'react'
import type { Group } from 'three'
import { PRIORITY_META, STATUS_META } from '../data/meta'
import { taskKey } from '../data/selectors'
import { useOffice } from '../store'
import { boxLive } from './runtime'
import { SceneHtml } from './shared'

export function TaskTooltip() {
  const id = useOffice((s) => (s.hover?.kind === 'task' && !s.drag ? s.hover.id : null))
  const task = useOffice((s) => (id ? s.tasks[id] : undefined))
  const project = useOffice((s) => (task ? s.projects[task.projectId] : undefined))
  const ref = useRef<Group>(null)

  useFrame(() => {
    const g = ref.current
    if (!g || !id) return
    const b = boxLive.get(id)
    if (b) g.position.set(b.x, b.y + 0.85, b.z)
  })

  if (!id || !task) return null
  return (
    <group ref={ref}>
      <SceneHtml center zIndexRange={[0, 0]} pointerEvents="none">
        <div
          style={{
            background: 'rgba(255,255,255,0.97)',
            borderRadius: 10,
            padding: '5px 10px',
            boxShadow: '0 4px 14px rgba(30,45,90,0.25)',
            font: '600 12px var(--font, sans-serif)',
            color: '#1b2333',
            maxWidth: 240,
            transform: 'translateY(-14px)',
            userSelect: 'none',
          }}
        >
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: project?.color ?? '#9aa3b5' }} />
            <span style={{ color: '#6b7487', fontWeight: 700 }}>{taskKey(task, project?.key)}</span>
            <span style={{ color: PRIORITY_META[task.priority].color }}>{PRIORITY_META[task.priority].label}</span>
            <span style={{ color: STATUS_META[task.status].color }}>{STATUS_META[task.status].label}</span>
          </div>
          <div style={{ marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</div>
        </div>
      </SceneHtml>
    </group>
  )
}
