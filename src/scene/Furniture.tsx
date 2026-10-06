// Static furniture, deliberately sparse: chairs, meeting table, two sofas, two plants, two shelves.
import { OFFICE } from '../office/layout'
import { useOffice } from '../store'
import { PALETTE } from '../theme'
import { Cyl, RBlock, UNIT_SPHERE, stdMat, tint } from './shared'
import { meetingSeat, ROOMS } from './paths'
import { noRaycast } from './runtime'

type V3 = [number, number, number]

/** Chair: a rounded seat block + back, origin on the floor, seat facing +z (backrest at -z). */
export function Chair({ p, ry = 0, c = PALETTE.furnitureDark }: { p: V3; ry?: number; c?: string }) {
  return (
    <group position={p} rotation={[0, ry, 0]}>
      <RBlock p={[0, 0.2, 0]} s={[0.14, 0.4, 0.14]} c={c} round={0.04} />
      <RBlock p={[0, 0.44, 0]} s={[0.5, 0.1, 0.5]} c={c} round={0.05} />
      <RBlock p={[0, 0.72, -0.22]} s={[0.5, 0.46, 0.07]} c={c} round={0.03} />
    </group>
  )
}

const LEAF = tint(PALETTE.dropOk, 0.55)

/** Simple round plant: a pot cylinder with a sphere of leaves. */
function Plant({ p, s = 1 }: { p: V3; s?: number }) {
  return (
    <group position={p} scale={s}>
      <Cyl p={[0, 0.22, 0]} rh={[0.3, 0.44]} c={PALETTE.wall} />
      <mesh position={[0, 0.82, 0]} scale={0.42} geometry={UNIT_SPHERE} material={stdMat(LEAF)} castShadow />
    </group>
  )
}

/** Block sofa along local x, back at -z, seat facing +z. */
function Sofa({ p, ry = 0, w = 4, d = 0.95 }: { p: V3; ry?: number; w?: number; d?: number }) {
  return (
    <group position={p} rotation={[0, ry, 0]}>
      <RBlock p={[0, 0.22, 0.05]} s={[w, 0.44, d - 0.1]} c={PALETTE.furnitureDark} round={0.1} />
      <RBlock p={[0, 0.55, -d / 2 + 0.12]} s={[w, 0.7, 0.24]} c={PALETTE.furnitureDark} round={0.1} />
    </group>
  )
}

function MeetingRoom() {
  const { cx, cz, tableW, tableD } = ROOMS.meeting
  const chairs = Array.from({ length: 10 }, (_, i) => meetingSeat(i))
  return (
    <group>
      <RBlock p={[cx, 0.72, cz]} s={[tableW, 0.06, tableD]} c={PALETTE.deskTop} round={0.04} />
      <RBlock p={[cx - tableW / 2 + 0.5, 0.35, cz]} s={[0.08, 0.7, tableD - 0.3]} c={PALETTE.furniture} round={0.02} />
      <RBlock p={[cx + tableW / 2 - 0.5, 0.35, cz]} s={[0.08, 0.7, tableD - 0.3]} c={PALETTE.furniture} round={0.02} />
      {chairs.map((s, i) => (
        <Chair key={i} p={[s.x, 0, s.z]} ry={s.facing} />
      ))}
    </group>
  )
}

function Lounge() {
  const { cx, cz, sofaNorthZ, sofaSouthZ, sofaW, sofaD, tableW, tableD } = ROOMS.lounge
  const L = OFFICE.lounge
  return (
    <group>
      <Sofa p={[cx, 0, sofaNorthZ]} ry={0} w={sofaW} d={sofaD} />
      <Sofa p={[cx, 0, sofaSouthZ]} ry={Math.PI} w={sofaW} d={sofaD} />
      <RBlock p={[cx, 0.17, cz]} s={[tableW, 0.34, tableD]} c={PALETTE.furniture} round={0.08} />
      <Plant p={[L.x + L.w - 0.7, 0, L.z + 0.6]} s={1.1} />
    </group>
  )
}

/** Board heights (top surface) of the backlog shelf levels. Shared with box placement. */
export const BACKLOG_LEVELS = [0.18, 0.9, 1.62, 2.34]
export const BACKLOG_CENTER_X = OFFICE.backlogShelf.x + OFFICE.backlogShelf.w * 0.45
export const DONE_TOP = 0.95

/** Open shelving for unassigned tasks; glows when a drag would drop to the backlog. */
export function BacklogShelf() {
  const A = OFFICE.backlogShelf
  const hot = useOffice((s) => s.dropTarget?.kind === 'backlog')
  const depth = 0.75
  const top = BACKLOG_LEVELS[BACKLOG_LEVELS.length - 1] + 0.7
  const dividers = Math.floor(A.d / 1.5)
  return (
    <group position={[BACKLOG_CENTER_X, 0, A.z + A.d / 2]}>
      <RBlock p={[0, top / 2, -A.d / 2 + 0.03]} s={[depth, top, 0.06]} c={PALETTE.wall} round={0.02} />
      <RBlock p={[0, top / 2, A.d / 2 - 0.03]} s={[depth, top, 0.06]} c={PALETTE.wall} round={0.02} />
      {Array.from({ length: dividers - 1 }, (_, i) => (
        <RBlock key={i} p={[0, top / 2, -A.d / 2 + ((i + 1) * A.d) / dividers]} s={[depth, top, 0.04]} c={PALETTE.wall} round={0.015} />
      ))}
      {BACKLOG_LEVELS.map((y, i) => (
        <RBlock key={i} p={[0, y - 0.03, 0]} s={[depth, 0.06, A.d]} c={PALETTE.accentSoft} round={0.02} />
      ))}
      <RBlock p={[0, top + 0.02, 0]} s={[depth, 0.05, A.d]} c={PALETTE.accentSoft} round={0.02} />
      {hot && (
        <mesh position={[depth / 2 + 0.05, top / 2, 0]} rotation={[0, Math.PI / 2, 0]} renderOrder={3} raycast={noRaycast}>
          <planeGeometry args={[A.d + 0.4, top + 0.4]} />
          <meshBasicMaterial color={PALETTE.dropOk} transparent opacity={0.28} depthWrite={false} />
        </mesh>
      )}
    </group>
  )
}

export function DoneShelf() {
  const A = OFFICE.doneShelf
  return (
    <group position={[A.x + A.w / 2, 0, A.z + A.d / 2]}>
      <RBlock p={[0, DONE_TOP / 2 - 0.03, 0]} s={[A.w, DONE_TOP - 0.06, A.d]} c={PALETTE.wall} round={0.04} />
      <RBlock p={[0, DONE_TOP - 0.03, 0]} s={[A.w + 0.04, 0.05, A.d + 0.04]} c={PALETTE.accentSoft} round={0.02} />
    </group>
  )
}

export function Decor() {
  return (
    <group>
      <MeetingRoom />
      <Lounge />
      <BacklogShelf />
      <DoneShelf />
      <Plant p={[1.1, 0, 12.2]} s={1.1} />
    </group>
  )
}
