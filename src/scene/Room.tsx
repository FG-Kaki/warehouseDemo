// Near-white floor with faint tile lines, thin waist-high walls, glass meeting room with an accent frame.
import { useEffect, useMemo } from 'react'
import { CanvasTexture, Color, DoubleSide, MeshStandardMaterial, RepeatWrapping, SRGBColorSpace } from 'three'
import { OFFICE } from '../office/layout'
import { PALETTE } from '../theme'
import { Block, RBlock, stdMat } from './shared'
import { ROOMS } from './paths'

const W = OFFICE.width
const D = OFFICE.depth
const T = 0.14 // wall thickness
const H = 1.0 // cutaway wall height
const E = OFFICE.entrance
const MEET = OFFICE.meetingRoom

// Darker plinth edge so the floor slab separates from the background.
const PLINTH = '#' + new Color(PALETTE.wallTrim).lerp(new Color(PALETTE.shadow), 0.16).getHexString()

function makeTileTexture() {
  const size = 128
  const cv = document.createElement('canvas')
  cv.width = size
  cv.height = size
  const g = cv.getContext('2d')
  if (g) {
    g.fillStyle = PALETTE.floor
    g.fillRect(0, 0, size, size)
    g.strokeStyle = PALETTE.floorLine
    g.lineWidth = 2
    g.strokeRect(0, 0, size, size)
  }
  const tex = new CanvasTexture(cv)
  tex.colorSpace = SRGBColorSpace
  tex.wrapS = tex.wrapT = RepeatWrapping
  tex.repeat.set(W, D)
  tex.anisotropy = 8
  return tex
}

function Floor() {
  const tex = useMemo(() => makeTileTexture(), [])
  const top = useMemo(() => new MeshStandardMaterial({ map: tex, roughness: 1 }), [tex])
  useEffect(
    () => () => {
      tex.dispose()
      top.dispose()
    },
    [tex, top],
  )
  const side = stdMat(PLINTH)
  return (
    <>
      <mesh position={[W / 2, -0.15, D / 2]} scale={[W, 0.3, D]} material={[side, side, top, side, side, side]} receiveShadow>
        <boxGeometry args={[1, 1, 1]} />
      </mesh>
      <RBlock p={[W / 2, -0.17, D / 2]} s={[W + 0.7, 0.26, D + 0.7]} c={PLINTH} round={0.1} cast={false} receive={false} />
    </>
  )
}

/** Axis-aligned thin wall spanning [x0,x1] × [z0,z1] with a softly rounded cap. */
function Wall({ x0, x1, z0, z1 }: { x0: number; x1: number; z0: number; z1: number }) {
  const cx = (x0 + x1) / 2
  const cz = (z0 + z1) / 2
  const sx = Math.abs(x1 - x0)
  const sz = Math.abs(z1 - z0)
  return <RBlock p={[cx, H / 2, cz]} s={[sx, H, sz]} c={PALETTE.wall} round={0.06} />
}

const glassMat = new MeshStandardMaterial({
  color: PALETTE.glass,
  transparent: true,
  opacity: 0.13,
  roughness: 0.2,
  side: DoubleSide,
  depthWrite: false,
})

const GH = 2.3 // glass wall height
const FT = 0.04 // frame thickness

/** One glass panel between two points of an axis-aligned line, with thin accent rails top and bottom. */
function GlassPane({ x0, x1, z0, z1 }: { x0: number; x1: number; z0: number; z1: number }) {
  const cx = (x0 + x1) / 2
  const cz = (z0 + z1) / 2
  const sx = Math.max(Math.abs(x1 - x0), FT)
  const sz = Math.max(Math.abs(z1 - z0), FT)
  return (
    <>
      <mesh position={[cx, GH / 2, cz]} material={glassMat} renderOrder={2}>
        <boxGeometry args={[sx, GH, sz]} />
      </mesh>
      <Block p={[cx, FT / 2, cz]} s={[sx, FT, sz]} c={PALETTE.accentSoft} cast={false} />
      <Block p={[cx, GH, cz]} s={[sx, FT, sz]} c={PALETTE.accentSoft} cast={false} />
    </>
  )
}

function MeetingGlass() {
  const x0 = MEET.x
  const x1 = MEET.x + MEET.w
  const z0 = MEET.z
  const z1 = MEET.z + MEET.d
  const g0 = ROOMS.meeting.doorZ - ROOMS.meeting.doorHalf
  const g1 = ROOMS.meeting.doorZ + ROOMS.meeting.doorHalf
  const posts: [number, number][] = [
    [x0, z0],
    [x1, z0],
    [x0, z1],
    [x1, z1],
    [x0, g0],
    [x0, g1],
  ]
  return (
    <>
      <GlassPane x0={x0} x1={x1} z0={z0} z1={z0} />
      <GlassPane x0={x0} x1={x1} z0={z1} z1={z1} />
      <GlassPane x0={x1} x1={x1} z0={z0} z1={z1} />
      <GlassPane x0={x0} x1={x0} z0={z0} z1={g0} />
      <GlassPane x0={x0} x1={x0} z0={g1} z1={z1} />
      {posts.map(([px, pz], i) => (
        <Block key={i} p={[px, GH / 2, pz]} s={[FT * 1.4, GH, FT * 1.4]} c={PALETTE.accentSoft} cast={false} />
      ))}
    </>
  )
}

export function Room() {
  return (
    <group>
      <Floor />
      {/* Cutaway outer walls, just outside the floor rectangle; the west wall has the entrance gap. */}
      <Wall x0={-T} x1={W + T} z0={-T} z1={0} />
      <Wall x0={-T} x1={W + T} z0={D} z1={D + T} />
      <Wall x0={W} x1={W + T} z0={0} z1={D} />
      <Wall x0={-T} x1={0} z0={0} z1={E.z} />
      <Wall x0={-T} x1={0} z0={E.z + E.d} z1={D} />
      <MeetingGlass />
    </group>
  )
}
