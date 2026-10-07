// One cube bot: a rounded cube in the member color with a dark screen face (two eye dots) and a floating
// status diamond. Presence decides where it goes; it hovers/glides along the waypoint graph, never teleports.
import { useFrame } from '@react-three/fiber'
import { memo, useEffect, useMemo, useRef } from 'react'
import { Color, MathUtils, MeshStandardMaterial, OctahedronGeometry, type Group } from 'three'
import type { Id, Member, Presence } from '../data/types'
import { SIGNAL_META } from '../data/insights'
import { useOffice } from '../store'
import { PALETTE } from '../theme'
import { roundedGeo, SceneHtml, UNIT_CYL, UNIT_SPHERE, useDynamicLayer } from './shared'
import { parseSignalKey, signalKeyOf, useToday } from './signals'
import {
  ENTRANCE_NODE,
  ENTRANCE_OUT,
  EXIT_SPOT,
  NODES,
  deskIndex,
  deskSeat,
  findRoute,
  loungeSpot,
  meetingSeat,
  type Spot,
} from './paths'
import { avatarLive, DRAG_THRESHOLD_PX, setCursor, type AvatarLive } from './runtime'

const SPEED = 1.4
const CUBE = 0.55
const BODY = roundedGeo(CUBE, CUBE, CUBE, 0.16)
const SCREEN = roundedGeo(0.42, 0.22, 0.05, 0.06)
const EYE_BAR = roundedGeo(0.075, 0.03, 0.03, 0.012)
const GEM = new OctahedronGeometry(1, 0)
const HOVER_Y = 0.05
const SEAT_Y = 0.47
const WHITE = new Color('#ffffff')
const BLACK = new Color('#000000')

function lerpAngle(a: number, b: number, k: number) {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  else if (d < -Math.PI) d += Math.PI * 2
  return a + d * k
}

function spotFor(deskId: string, memberId: Id, presence: Presence): Spot {
  const idx = deskIndex(deskId, memberId)
  switch (presence) {
    case 'working':
      return deskSeat(deskId) ?? loungeSpot(idx)
    case 'meeting':
      return meetingSeat(idx)
    case 'break':
      return loungeSpot(idx)
    default:
      return EXIT_SPOT
  }
}

interface Walker {
  init: boolean
  x: number
  z: number
  yaw: number
  spot: Spot | null
  anchor: number
  rx: number[]
  rz: number[]
  rn: number[]
  ri: number
  atSpot: boolean
  sit: number
  walk: number
  phase: number
  alpha: number
  gone: boolean
}

function newWalker(): Walker {
  return { init: false, x: 0, z: 0, yaw: 0, spot: null, anchor: ENTRANCE_NODE, rx: [], rz: [], rn: [], ri: 0, atSpot: false, sit: 0, walk: 0, phase: 0, alpha: -1, gone: false }
}

function replan(w: Walker, spot: Spot) {
  let start: number
  if (w.atSpot && w.spot) start = w.spot.node
  else if (w.ri < w.rx.length && w.rn[w.ri] >= 0) start = w.rn[w.ri]
  else if (w.spot) start = w.spot.node
  else start = w.anchor
  const nodes = findRoute(start, spot.node)
  const rx: number[] = []
  const rz: number[] = []
  const rn: number[] = []
  for (const n of nodes) {
    rx.push(NODES[n].x)
    rz.push(NODES[n].z)
    rn.push(n)
  }
  rx.push(spot.x)
  rz.push(spot.z)
  rn.push(-1)
  w.rx = rx
  w.rz = rz
  w.rn = rn
  w.ri = 0
  w.atSpot = false
  w.spot = spot
}

interface AvatarProps {
  member: Member
  spawn: 'target' | 'entrance'
  leaving: boolean
  onGone: (id: Id) => void
}

export const Avatar = memo(function Avatar({ member, spawn, leaving, onGone }: AvatarProps) {
  const id = member.id
  const deskId = member.deskId
  const presence: Presence = leaving ? 'away' : member.presence
  // Only identity, desk and presence decide where the bot goes; other edits must not make it stand up.
  const spot = useMemo(() => spotFor(deskId, id, presence), [deskId, id, presence])

  // Signal is memoized on tasks/member changes; nothing is computed per frame.
  const today = useToday()
  const signalKey = useOffice((s) => signalKeyOf(member, s.tasks, today))
  const signal = useMemo(() => parseSignalKey(signalKey), [signalKey])
  const signalColor = SIGNAL_META[signal.level].color
  const alert = signal.level === 'alert'

  const selected = useOffice((s) => s.selection?.kind === 'member' && s.selection.id === id)
  const hovered = useOffice((s) => s.hover?.kind === 'member' && s.hover.id === id)
  const dropHot = useOffice((s) => s.dropTarget?.kind === 'member' && s.dropTarget.id === id)

  const variant = member.avatarVariant
  const mats = useMemo(() => {
    const mk = (c: Color) => new MeshStandardMaterial({ color: c, roughness: 0.55 })
    const base = new Color(member.color)
    return {
      body: mk(base),
      screen: mk(base.clone().lerp(BLACK, 0.72)),
      eye: new MeshStandardMaterial({ color: WHITE.clone().lerp(base, 0.06), roughness: 0.4, emissive: WHITE.clone().lerp(base, 0.2), emissiveIntensity: 0.35 }),
      nub: mk(base.clone().lerp(WHITE, 0.35)),
      gem: new MeshStandardMaterial({ color: new Color(SIGNAL_META.ok.color), roughness: 0.3, emissive: new Color(SIGNAL_META.ok.color), emissiveIntensity: 0.5 }),
    }
  }, [member.color])
  useEffect(() => {
    mats.gem.color.set(signalColor)
    mats.gem.emissive.set(signalColor)
  }, [mats, signalColor])
  useEffect(() => {
    walkerReset.current = true
    return () => {
      Object.values(mats).forEach((m) => m.dispose())
    }
  }, [mats])

  const root = useRef<Group>(null)
  const lift = useRef<Group>(null)
  const float = useRef<Group>(null)
  const gem = useRef<Group>(null)
  const eyes = useRef<Group>(null)
  useDynamicLayer(root)
  const walker = useRef<Walker>(newWalker())
  const walkerReset = useRef(false)
  const live = useRef<AvatarLive>({ x: 0, z: 0, visible: false })
  const seed = useMemo(() => {
    let h = 0
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 997
    return h / 997
  }, [id])

  useEffect(() => {
    const l = live.current
    avatarLive.set(id, l)
    return () => {
      if (avatarLive.get(id) === l) avatarLive.delete(id)
      const s = useOffice.getState()
      if (s.hover?.kind === 'member' && s.hover.id === id) s.setHover(null)
    }
  }, [id])

  useEffect(() => {
    if (lift.current) lift.current.rotation.order = 'YXZ'
  }, [])

  useFrame((state, delta) => {
    const g = root.current
    if (!g) return
    // `delta` (real time) drives walking so low fps doesn't slow the bots; `dt` is only for smoothing/animation.
    const dt = Math.min(delta, 0.1)
    const w = walker.current
    if (walkerReset.current) {
      walkerReset.current = false
      w.alpha = -1 // new materials: re-apply the door fade
    }

    if (!w.init) {
      w.init = true
      if (spawn === 'entrance') {
        w.x = ENTRANCE_OUT.x
        w.z = ENTRANCE_OUT.z
        w.yaw = Math.PI / 2
        w.spot = null
      } else {
        w.x = spot.x
        w.z = spot.z
        w.yaw = spot.facing
        w.spot = spot
        w.atSpot = true
        w.sit = spot.seated ? 1 : 0
      }
    }
    if (w.spot !== spot) {
      replan(w, spot)
      w.gone = false
    }

    // ---- movement along waypoints (leftover distance carries over to the next waypoint) ----
    let moving = false
    let desiredYaw = w.yaw
    if (!w.atSpot) {
      if (delta > 1 && w.spot) {
        // The tab was in the background: arrive instead of replaying the whole walk.
        w.x = w.spot.x
        w.z = w.spot.z
        w.ri = w.rx.length
      }
      let step = SPEED * delta
      moving = true
      while (!w.atSpot) {
        if (w.ri >= w.rx.length) {
          w.atSpot = true
          break
        }
        const dx = w.rx[w.ri] - w.x
        const dz = w.rz[w.ri] - w.z
        const d = Math.hypot(dx, dz)
        if (d <= step) {
          step -= d
          w.x = w.rx[w.ri]
          w.z = w.rz[w.ri]
          if (w.rn[w.ri] >= 0) w.anchor = w.rn[w.ri]
          w.ri++
        } else {
          w.x += (dx / d) * step
          w.z += (dz / d) * step
          desiredYaw = Math.atan2(dx, dz)
          break
        }
      }
    }
    if (w.atSpot && w.spot) desiredYaw = w.spot.facing
    w.yaw = lerpAngle(w.yaw, desiredYaw, 1 - Math.exp(-(moving ? 9 : 6) * dt))

    const sitGoal = w.atSpot && w.spot?.seated ? 1 : 0
    w.sit += (sitGoal - w.sit) * (1 - Math.exp(-7 * dt))
    w.walk += ((moving ? 1 : 0) - w.walk) * (1 - Math.exp(-8 * dt))
    if (moving) w.phase += dt * 6

    // ---- fade at the door ----
    const alpha = MathUtils.clamp((w.x + 1.0) / 1.2, 0, 1)
    if (Math.abs(alpha - w.alpha) > 0.004) {
      w.alpha = alpha
      const tr = alpha < 0.999
      for (const m of Object.values(mats)) {
        if (m.transparent !== tr) {
          m.transparent = tr
          m.needsUpdate = true
        }
        m.opacity = alpha
      }
      g.visible = alpha > 0.01
    }
    live.current.x = w.x
    live.current.z = w.z
    live.current.visible = alpha > 0.05

    if (leaving && w.atSpot && w.spot?.exit && !w.gone) {
      w.gone = true
      onGone(id)
    }

    // ---- pose ----
    g.position.x = w.x
    g.position.z = w.z
    const t = state.clock.elapsedTime
    const working = presence === 'working' && w.sit > 0.5
    const bob = Math.sin(w.phase * 1.6) * 0.025 * w.walk
    const idleBob = Math.sin(t * 1.5 + seed * 6) * 0.012 * (1 - w.walk) * (1 - w.sit)
    const y = MathUtils.lerp(HOVER_Y + bob + idleBob, SEAT_Y, w.sit)
    const breathe = Math.sin(t * 1.8 + seed * 9) * 0.01 * w.sit
    const l = lift.current
    if (l) {
      l.position.y = y
      l.rotation.y = w.yaw
      l.rotation.x = 0.1 * w.walk
      l.rotation.z = Math.sin(w.phase * 0.8) * 0.035 * w.walk
      l.scale.y = 1 + breathe
    }
    const e = eyes.current
    if (e) {
      // blink every few seconds; glance around slightly while working
      const period = 3.6 + seed * 2.4
      const bp = (t + seed * 10) % period
      e.scale.y = bp < 0.12 ? 0.12 : 1
      e.position.x = working ? Math.sin(t * 0.55 + seed * 7) * 0.035 : 0
      e.position.y = working ? Math.sin(t * 0.37 + seed * 3) * 0.012 : 0
    }
    if (float.current) float.current.position.y = y + CUBE + 0.42 + Math.sin(t * 1.3 + seed * 5) * 0.04
    if (gem.current) {
      gem.current.rotation.y += dt * 0.9
      if (alert) mats.gem.emissiveIntensity = 0.55 + 0.4 * (0.5 + 0.5 * Math.sin(t * 2.2 + seed * 4))
      else if (mats.gem.emissiveIntensity !== 0.5) mats.gem.emissiveIntensity = 0.5
    }
  })

  const ringColor = dropHot ? PALETTE.dropOk : selected ? PALETTE.selection : hovered ? PALETTE.hover : null
  const showTag = selected || hovered || dropHot
  const tagText = signal.reasons.length ? `${member.name} · ${signal.reasons.join(', ')}` : `${member.name} · ${SIGNAL_META.ok.label}`
  const roundEyes = variant % 2 === 0
  const eyeY = CUBE / 2 + 0.03

  return (
    <group
      ref={root}
      onPointerOver={(e) => {
        if (!live.current.visible || useOffice.getState().drag) return
        e.stopPropagation()
        useOffice.getState().setHover({ kind: 'member', id })
        setCursor('pointer')
      }}
      onPointerOut={() => {
        const s = useOffice.getState()
        if (s.hover?.kind === 'member' && s.hover.id === id) s.setHover(null)
        if (!s.drag) setCursor('')
      }}
      onClick={(e) => {
        if (!live.current.visible) return
        e.stopPropagation()
        if (e.delta > DRAG_THRESHOLD_PX) return
        useOffice.getState().select({ kind: 'member', id })
      }}
    >
      <group ref={lift}>
        <mesh geometry={BODY} material={mats.body} position={[0, CUBE / 2, 0]} castShadow receiveShadow />
        <mesh geometry={SCREEN} material={mats.screen} position={[0, eyeY, CUBE / 2 - 0.008]} />
        <group ref={eyes}>
          {roundEyes ? (
            <>
              <mesh geometry={UNIT_SPHERE} material={mats.eye} position={[-0.09, eyeY, CUBE / 2 + 0.022]} scale={[0.035, 0.035, 0.02]} />
              <mesh geometry={UNIT_SPHERE} material={mats.eye} position={[0.09, eyeY, CUBE / 2 + 0.022]} scale={[0.035, 0.035, 0.02]} />
            </>
          ) : (
            <>
              <mesh geometry={EYE_BAR} material={mats.eye} position={[-0.09, eyeY, CUBE / 2 + 0.03]} rotation={[0, 0, Math.PI / 2]} />
              <mesh geometry={EYE_BAR} material={mats.eye} position={[0.09, eyeY, CUBE / 2 + 0.03]} rotation={[0, 0, Math.PI / 2]} />
            </>
          )}
        </group>
        {variant % 3 === 0 && (
          <>
            <mesh geometry={UNIT_CYL} material={mats.nub} position={[0, CUBE + 0.04, 0]} scale={[0.012, 0.08, 0.012]} />
            <mesh geometry={UNIT_SPHERE} material={mats.nub} position={[0, CUBE + 0.095, 0]} scale={0.032} castShadow />
          </>
        )}
      </group>

      {/* soft ring on the floor for selection / hover / drop */}
      {ringColor && (
        <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]} scale={dropHot ? 1.3 : 1} renderOrder={4}>
          <ringGeometry args={[0.5, 0.62, 40]} />
          <meshBasicMaterial color={ringColor} transparent opacity={0.65} depthWrite={false} />
        </mesh>
      )}

      {/* status diamond (plumbob): slow spin, gentle bob, color = signal */}
      <group ref={float}>
        <group ref={gem}>
          <mesh geometry={GEM} material={mats.gem} scale={[0.09, 0.15, 0.09]} castShadow />
        </group>
        {showTag && (
          <SceneHtml position={[0, 0.34, 0]} center zIndexRange={[0, 0]} pointerEvents="none">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                padding: '3px 9px',
                borderRadius: 999,
                background: 'rgba(255,255,255,0.96)',
                boxShadow: '0 2px 8px rgba(30,45,90,0.16)',
                font: '600 12px var(--font, sans-serif)',
                color: '#1b2333',
                whiteSpace: 'nowrap',
                userSelect: 'none',
              }}
            >
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: signalColor, flex: 'none' }} />
              {tagText}
            </div>
          </SceneHtml>
        )}
      </group>
    </group>
  )
})
