// Floor overlays. 'workload': a glowing disc under every occupied desk. (deadline/project tint the boxes themselves.)
import { useFrame } from '@react-three/fiber'
import { memo, useEffect, useMemo, useRef } from 'react'
import { Color, MeshBasicMaterial, type Mesh } from 'three'
import { workload, workloadLevel } from '../data/selectors'
import type { Id, Member } from '../data/types'
import { deskById } from '../office/layout'
import { useOffice } from '../store'
import { deskLocalToWorld } from './Desks'
import { noRaycast } from './runtime'

const tmp = { x: 0, z: 0 }

const Disc = memo(function Disc({ member, ratio }: { member: Member; ratio: number }) {
  const desk = deskById(member.deskId)
  const level = workloadLevel(ratio)
  const over = ratio > 1.3
  const mat = useMemo(() => new MeshBasicMaterial({ color: new Color(level.color), transparent: true, opacity: 0.45, depthWrite: false }), [level.color])
  const halo = useMemo(() => new MeshBasicMaterial({ color: new Color(level.color), transparent: true, opacity: 0.18, depthWrite: false }), [level.color])
  useEffect(
    () => () => {
      mat.dispose()
      halo.dispose()
    },
    [mat, halo],
  )
  const core = useRef<Mesh>(null)
  const ring = useRef<Mesh>(null)
  const height = 0.03 + Math.min(ratio, 2) * 0.1

  useFrame((state) => {
    const t = state.clock.elapsedTime
    const pulse = over ? 0.5 + 0.5 * Math.sin(t * 2 + member.avatarVariant) : 0
    if (core.current) core.current.scale.y = height * (1 + pulse * 0.6)
    if (ring.current) {
      const s = 1 + (over ? pulse * 0.18 : 0.04 * Math.sin(t * 1.5))
      ring.current.scale.set(s, 1, s)
    }
    mat.opacity = 0.4 + pulse * 0.2
    halo.opacity = 0.14 + pulse * 0.14
  })

  if (!desk) return null
  deskLocalToWorld(desk, 0, -0.5, tmp)
  return (
    <group position={[tmp.x, 0, tmp.z]}>
      <mesh ref={core} position={[0, 0.01, 0]} material={mat} renderOrder={2} raycast={noRaycast}>
        <cylinderGeometry args={[1.0, 1.0, 1, 40]} />
      </mesh>
      <mesh ref={ring} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} material={halo} renderOrder={1} raycast={noRaycast}>
        <circleGeometry args={[1.55, 40]} />
      </mesh>
    </group>
  )
})

export function Overlays() {
  const overlay = useOffice((s) => s.overlay)
  if (overlay !== 'workload') return null
  return <WorkloadDiscs />
}

function WorkloadDiscs() {
  const members = useOffice((s) => s.members)
  const tasks = useOffice((s) => s.tasks)
  const rows = useMemo(() => {
    const out: { member: Member; ratio: number }[] = []
    for (const m of Object.values(members)) out.push({ member: m, ratio: Math.round(workload(m, tasks) * 100) / 100 })
    return out
  }, [members, tasks])
  return (
    <>
      {rows.map((r: { member: Member; ratio: number }) => (
        <Disc key={r.member.id as Id} member={r.member} ratio={r.ratio} />
      ))}
    </>
  )
}
