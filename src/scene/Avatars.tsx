// One Avatar per member, plus short-lived "leaving" ghosts for removed members.
import { useCallback, useReducer, useRef } from 'react'
import type { Id, Member } from '../data/types'
import { useOffice } from '../store'
import { Avatar } from './Avatar'

export function Avatars() {
  const members = useOffice((s) => s.members)
  const status = useOffice((s) => s.status)
  const [, bump] = useReducer((n: number) => n + 1, 0)

  const known = useRef(new Map<Id, Member>())
  const ghosts = useRef(new Map<Id, Member>())
  const spawn = useRef(new Map<Id, 'target' | 'entrance'>())
  const firstBatch = useRef(true)

  // Members present in the first loaded workspace appear in place; later arrivals walk in from the door.
  for (const id of Object.keys(members)) {
    if (!spawn.current.has(id)) spawn.current.set(id, firstBatch.current ? 'target' : 'entrance')
    ghosts.current.delete(id)
  }
  if (status === 'ready') firstBatch.current = false

  // Removed members keep their avatar mounted (same key) so it can walk out and fade.
  for (const [id, m] of known.current) {
    if (!members[id] && !ghosts.current.has(id)) ghosts.current.set(id, m)
  }
  known.current = new Map(Object.entries(members))

  const onGone = useCallback((id: Id) => {
    if (ghosts.current.delete(id)) {
      spawn.current.delete(id)
      bump()
    }
  }, [])

  const list = [...Object.values(members), ...ghosts.current.values()]
  return (
    <>
      {list.map((m) => (
        <Avatar key={m.id} member={m} spawn={spawn.current.get(m.id) ?? 'target'} leaving={ghosts.current.has(m.id)} onGone={onGone} />
      ))}
    </>
  )
}
