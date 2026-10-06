// Desk (white rounded top + two slab legs), thin monitor and a chair at every OFFICE.desks spot.
import { useFrame } from '@react-three/fiber'
import { memo, useEffect, useMemo, useRef } from 'react'
import { Color, MeshStandardMaterial } from 'three'
import { OFFICE, type DeskSpot } from '../office/layout'
import { useOffice } from '../store'
import { PALETTE } from '../theme'
import type { Id } from '../data/types'
import { RBlock } from './shared'
import { noRaycast } from './runtime'
import { Chair } from './Furniture'
import { CHAIR_OFFSET } from './paths'

const SIZE = OFFICE.deskSize
const TOP_Y = 0.74

/** Desk-local → world position (desk facing rotates local +z toward the monitor side). */
export function deskLocalToWorld(d: DeskSpot, lx: number, lz: number, out: { x: number; z: number }) {
  const c = Math.cos(d.facing)
  const s = Math.sin(d.facing)
  out.x = d.x + lx * c + lz * s
  out.z = d.z - lx * s + lz * c
}
export const DESK_TOP_Y = TOP_Y

const Desk = memo(function Desk({ desk, ownerId }: { desk: DeskSpot; ownerId: Id | null }) {
  const presence = useOffice((s) => (ownerId ? s.members[ownerId]?.presence : undefined))
  const hot = useOffice((s) => ownerId !== null && s.dropTarget?.kind === 'member' && s.dropTarget.id === ownerId)
  const occupied = ownerId !== null
  const working = presence === 'working'

  const screen = useMemo(() => new MeshStandardMaterial({ color: new Color(PALETTE.screenOff), roughness: 0.5 }), [])
  const onColor = useMemo(() => new Color(PALETTE.screenOn), [])
  const offColor = useMemo(() => new Color(PALETTE.screenOff), [])
  const glow = useRef(0)
  useEffect(() => () => screen.dispose(), [screen])

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05)
    const goal = working ? 1 : 0
    if (Math.abs(goal - glow.current) < 0.002) return
    glow.current += (goal - glow.current) * (1 - Math.exp(-6 * dt))
    screen.color.lerpColors(offColor, onColor, glow.current)
  })

  const chairZ = occupied ? -CHAIR_OFFSET : -CHAIR_OFFSET + 0.25

  return (
    <group position={[desk.x, 0, desk.z]} rotation={[0, desk.facing, 0]}>
      <RBlock p={[0, TOP_Y - 0.025, 0]} s={[SIZE.w, 0.05, SIZE.d]} c={PALETTE.deskTop} round={0.03} />
      <RBlock p={[-SIZE.w / 2 + 0.08, 0.35, 0]} s={[0.05, 0.7, SIZE.d - 0.2]} c={PALETTE.furniture} round={0.015} />
      <RBlock p={[SIZE.w / 2 - 0.08, 0.35, 0]} s={[0.05, 0.7, SIZE.d - 0.2]} c={PALETTE.furniture} round={0.015} />

      {/* thin monitor slab, screen toward the seated person (-z) */}
      <RBlock p={[-0.3, TOP_Y + 0.04, 0.3]} s={[0.2, 0.05, 0.14]} c={PALETTE.furniture} round={0.015} />
      <RBlock p={[-0.3, TOP_Y + 0.31, 0.3]} s={[0.72, 0.42, 0.03]} mat={screen} round={0.012} />

      <Chair p={[0, 0, chairZ]} c={occupied ? PALETTE.furnitureDark : PALETTE.furniture} />

      {hot && (
        <>
          <mesh position={[0, TOP_Y + 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={3} raycast={noRaycast}>
            <planeGeometry args={[SIZE.w + 0.1, SIZE.d + 0.1]} />
            <meshBasicMaterial color={PALETTE.dropOk} transparent opacity={0.5} depthWrite={false} />
          </mesh>
          <mesh position={[0, 0.03, -0.45]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={3} raycast={noRaycast}>
            <planeGeometry args={[SIZE.w + 0.7, SIZE.d + 1.9]} />
            <meshBasicMaterial color={PALETTE.dropOk} transparent opacity={0.2} depthWrite={false} />
          </mesh>
        </>
      )}
    </group>
  )
})

export function Desks() {
  const members = useOffice((s) => s.members)
  const ownerByDesk = useMemo(() => {
    const m = new Map<string, Id>()
    for (const x of Object.values(members)) m.set(x.deskId, x.id)
    return m
  }, [members])
  return (
    <>
      {OFFICE.desks.map((d) => (
        <Desk key={d.id} desk={d} ownerId={ownerByDesk.get(d.id) ?? null} />
      ))}
    </>
  )
}
