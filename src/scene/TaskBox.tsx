// One task as a little cargo box. Keeps its own world position and flies along an arc when its slot changes.
import { useFrame } from '@react-three/fiber'
import { memo, useEffect, useMemo, useRef } from 'react'
import { BackSide, Color, Mesh, MeshBasicMaterial, MeshStandardMaterial, type Group } from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { PRIORITY_META, WORKLOAD_LEVELS } from '../data/meta'
import { deadlineRisk, isOverdue } from '../data/selectors'
import type { Id } from '../data/types'
import type { Overlay } from '../store'
import { useOffice } from '../store'
import { PALETTE } from '../theme'
import { DESK_TOP_Y } from './Desks'
import { resetDropTracking, updateDropTarget } from './dropTarget'
import { boxLive, cameraLock, DRAG_THRESHOLD_PX, dragPoint, noRaycast, setCursor, type BoxLive } from './runtime'
import { clamp, UNIT_BOX, useDynamicLayer } from './shared'
import { BOX_D, BOX_W, boxHeight, type Slot } from './slots'

const ROUNDED = new RoundedBoxGeometry(1, 1, 1, 3, 0.1)
const meshRaycast = Mesh.prototype.raycast
const GRAY = new Color(PALETTE.wallTrim)
const GREEN = new Color(WORKLOAD_LEVELS[0].color)
const AMBER = new Color(PRIORITY_META.medium.color)
const RED = new Color(PRIORITY_META.urgent.color)

const hsl = { h: 0, s: 0, l: 0 }
/** Slightly desaturate so the boxes read as calm. */
function calm(c: Color): Color {
  c.getHSL(hsl)
  return c.setHSL(hsl.h, hsl.s * 0.8, hsl.l + (1 - hsl.l) * 0.06)
}

function riskColor(risk: number, out: Color): Color {
  if (risk < 0.5) return out.copy(GREEN).lerp(AMBER, risk / 0.5)
  return out.copy(AMBER).lerp(RED, (risk - 0.5) / 0.5)
}

function lerpAngle(a: number, b: number, k: number) {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  else if (d < -Math.PI) d += Math.PI * 2
  return a + d * k
}

/** Gap between boxes leaving the meeting table, so decisions read as being handed out one by one. */
const DEPART_STAGGER_MS = 60
let lastDepart = 0

const easeInOut = (u: number) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2)
const easeOutBack = (u: number) => 1 + 2.70158 * Math.pow(u - 1, 3) + 1.70158 * Math.pow(u - 1, 2)

interface Anim {
  init: boolean
  px: number
  py: number
  pz: number
  ry: number
  tx: number
  ty: number
  tz: number
  fx: number
  fy: number
  fz: number
  t: number
  dur: number
  arc: number
  flying: boolean
  /** Home of the slot we last flew to. */
  home: Slot['home'] | ''
  /** Seconds left before a started flight actually takes off. */
  wait: number
  lift: number
  pop: number
  scale: number
}

function newAnim(): Anim {
  return { init: false, px: 0, py: 0, pz: 0, ry: 0, tx: NaN, ty: 0, tz: 0, fx: 0, fy: 0, fz: 0, t: 0, dur: 1, arc: 0, flying: false, home: '', wait: 0, lift: 0, pop: 0, scale: 1 }
}

interface Props {
  id: Id
  slot: Slot
  /** Filtered out: translucent + desaturated. */
  dimmed: boolean
  overlay: Overlay
  /** Local date, rolls over at midnight so overdue/deadline colours update. */
  today: string
  /** Appeared after the first load: pop in instead of being there from the start. */
  pop: boolean
}

export const TaskBox = memo(function TaskBox({ id, slot, dimmed, overlay, pop, today }: Props) {
  const task = useOffice((s) => s.tasks[id])
  const projectColor = useOffice((s) => {
    const t = s.tasks[id]
    return t ? s.projects[t.projectId]?.color : undefined
  })
  const selected = useOffice((s) => s.selection?.kind === 'task' && s.selection.id === id)
  const hovered = useOffice((s) => s.hover?.kind === 'task' && s.hover.id === id)
  const isDragged = useOffice((s) => s.drag?.from === 'scene' && s.drag.taskId === id)

  const body = useMemo(() => new MeshStandardMaterial({ roughness: 0.55, metalness: 0, emissive: new Color(PALETTE.overdueGlow), emissiveIntensity: 0 }), [])
  const band = useMemo(() => new MeshStandardMaterial({ roughness: 0.5, metalness: 0 }), [])
  const outline = useMemo(() => new MeshBasicMaterial({ side: BackSide, transparent: true, opacity: 0.85, depthWrite: false }), [])
  useEffect(
    () => () => {
      body.dispose()
      band.dispose()
      outline.dispose()
    },
    [body, band, outline],
  )

  const vis = useMemo(() => {
    if (!task) return null
    const priority = calm(new Color(PRIORITY_META[task.priority].color))
    const proj = new Color(projectColor ?? PALETTE.wallTrim)
    let main = priority
    let strip = proj
    let opacity = 1
    if (overlay === 'project') {
      main = proj
      strip = priority
    } else if (overlay === 'deadline') {
      if (task.dueDate && task.status !== 'done') main = calm(riskColor(deadlineRisk(task, today), new Color()))
      else {
        main = new Color(PALETTE.furnitureDark)
        opacity = 0.4
      }
    }
    if (dimmed) {
      main = main.clone().lerp(GRAY, 0.75)
      strip = strip.clone().lerp(GRAY, 0.75)
      opacity = 0.22
    }
    return { main, strip, opacity, overdue: isOverdue(task, today), h: boxHeight(task.estimate) }
  }, [task, projectColor, overlay, dimmed, today])

  const group = useRef<Group>(null)
  useDynamicLayer(group)
  const outlineMesh = useRef<Mesh>(null)
  const anim = useRef<Anim>(newAnim())
  const live = useRef<BoxLive>({ x: 0, y: 0, z: 0 })
  const phase = useMemo(() => (id.length * 1.7 + id.charCodeAt(id.length - 1)) % 6.283, [id])

  useEffect(() => {
    outline.color.set(selected ? PALETTE.selection : PALETTE.hover)
  }, [outline, selected])

  useEffect(() => {
    const l = live.current
    boxLive.set(id, l)
    return () => {
      if (boxLive.get(id) === l) boxLive.delete(id)
      const s = useOffice.getState()
      if (s.hover?.kind === 'task' && s.hover.id === id) s.setHover(null)
    }
  }, [id])

  useFrame((state, delta) => {
    const g = group.current
    if (!g || !vis) return
    // `delta` drives flight progress and waits (real time, so low fps doesn't slow motion); `dt` is only for smoothing.
    const dt = Math.min(delta, 0.1)
    const a = anim.current
    const t = state.clock.elapsedTime

    if (!a.init) {
      a.init = true
      a.px = slot.x
      a.py = slot.y
      a.pz = slot.z
      a.ry = slot.rot
      a.tx = slot.x
      a.ty = slot.y
      a.tz = slot.z
      a.pop = pop ? 0 : 1
      a.scale = slot.scale
      a.home = slot.home
      body.color.copy(vis.main)
      band.color.copy(vis.strip)
      body.opacity = band.opacity = vis.opacity
    }

    // The tab was in the background: don't replay old flights, just be where we belong.
    if (delta > 1 && !isDragged) {
      a.px = a.tx = slot.x
      a.py = a.ty = slot.y
      a.pz = a.tz = slot.z
      a.flying = false
      a.wait = 0
      a.home = slot.home
      a.ry = slot.rot
      a.lift = 0
      a.scale = slot.scale
    }

    // ---- position: follow the pointer while dragged, otherwise fly to the slot ----
    if (isDragged && dragPoint.active) {
      const k = 1 - Math.exp(-28 * dt)
      a.px += (dragPoint.x - a.px) * k
      a.py += (dragPoint.y - a.py) * k
      a.pz += (dragPoint.z - a.pz) * k
      a.flying = false
      a.tx = NaN
    } else {
      if (slot.x !== a.tx || slot.y !== a.ty || slot.z !== a.tz) {
        a.tx = slot.x
        a.ty = slot.y
        a.tz = slot.z
        a.fx = a.px
        a.fy = a.py
        a.fz = a.pz
        const dist = Math.hypot(a.tx - a.px, a.ty - a.py, a.tz - a.pz)
        a.t = 0
        a.dur = clamp(0.35 + dist * 0.12, 0.35, 1.5)
        a.arc = dist < 0.8 ? dist * 0.3 : clamp(dist * 0.45 + 0.7, 0.9, 4.5)
        a.flying = dist > 0.004
        a.wait = 0
        if (a.flying && a.home === 'agenda' && slot.home !== 'agenda') {
          const now = performance.now()
          const start = Math.max(now, lastDepart + DEPART_STAGGER_MS)
          lastDepart = start
          a.wait = (start - now) / 1000
        }
        a.home = slot.home
      }
      if (a.flying && a.wait > 0) {
        a.wait -= delta
      } else if (a.flying) {
        a.t += delta / a.dur
        const u = Math.min(a.t, 1)
        const e = easeInOut(u)
        a.px = a.fx + (a.tx - a.fx) * e
        a.pz = a.fz + (a.tz - a.fz) * e
        a.py = a.fy + (a.ty - a.fy) * e + Math.sin(Math.PI * u) * a.arc
        if (u >= 1) a.flying = false
      }
    }

    // ---- hover lift, pop-in, wobble ----
    const liftGoal = hovered && !isDragged ? 0.1 : 0
    a.lift += (liftGoal - a.lift) * (1 - Math.exp(-14 * dt))
    if (a.pop < 1) a.pop = Math.min(1, a.pop + dt / 0.45)
    const scaleGoal = slot.scale * (isDragged ? 1.1 : 1)
    a.scale += (scaleGoal - a.scale) * (1 - Math.exp(-14 * dt))
    const popScale = a.pop < 1 ? easeOutBack(a.pop) : 1
    g.scale.setScalar(Math.max(0.0001, a.scale * popScale))

    a.ry = lerpAngle(a.ry, slot.rot, 1 - Math.exp(-8 * dt))
    g.position.set(a.px, a.py + a.lift, a.pz)
    if (slot.wobble > 0 && !a.flying && !isDragged) {
      // overloaded stack: a slight static tilt plus a very slow sway
      const tilt = 0.015 + (a.py - DESK_TOP_Y) * 0.022
      g.rotation.set(tilt * Math.sin(phase) + Math.sin(t * 0.5 + phase) * 0.007, a.ry, tilt * Math.cos(phase) + Math.cos(t * 0.4 + phase) * 0.007)
    } else if (isDragged) {
      g.rotation.set(0.05, a.ry, -0.05)
    } else {
      g.rotation.set(0, a.ry, 0)
    }
    live.current.x = a.px
    live.current.y = a.py + a.lift
    live.current.z = a.pz

    // ---- look ----
    const k = 1 - Math.exp(-9 * dt)
    body.color.lerp(vis.main, k)
    band.color.lerp(vis.strip, k)
    const op = body.opacity + (vis.opacity - body.opacity) * k
    body.opacity = band.opacity = op
    const tr = op < 0.995
    if (body.transparent !== tr) {
      body.transparent = band.transparent = tr
      body.needsUpdate = band.needsUpdate = true
    }
    if (vis.overdue && !dimmed) body.emissiveIntensity = 0.08 + 0.14 * (0.5 + 0.5 * Math.sin(t * 1.4 + phase))
    else if (body.emissiveIntensity !== 0) body.emissiveIntensity = Math.max(0, body.emissiveIntensity - dt * 2)

    const om = outlineMesh.current
    if (om) {
      const on = selected || hovered || isDragged
      if (om.visible !== on) om.visible = on
      outline.opacity = selected ? 0.75 + 0.25 * Math.sin(t * 5) : 0.85
    }
  })

  if (!task || !vis) return null
  const h = vis.h
  const raycast = isDragged ? noRaycast : meshRaycast

  return (
    <group
      ref={group}
      onPointerOver={(e) => {
        if (useOffice.getState().drag) return
        e.stopPropagation()
        useOffice.getState().setHover({ kind: 'task', id })
        setCursor(task.status === 'done' ? 'pointer' : 'grab')
      }}
      onPointerOut={() => {
        const s = useOffice.getState()
        if (s.hover?.kind === 'task' && s.hover.id === id) s.setHover(null)
        if (!s.drag) setCursor('')
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.stopPropagation()
        if (task.status === 'done') return
        const sx = e.nativeEvent.clientX
        const sy = e.nativeEvent.clientY
        const lock = cameraLock.controls
        if (lock) lock.enabled = false
        const cleanup = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        const move = (ev: PointerEvent) => {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) <= DRAG_THRESHOLD_PX) return
          cleanup()
          useOffice.getState().startDrag(id, 'scene')
          // Hit-test right away so a quick flick-and-release still has a drop target.
          resetDropTracking()
          updateDropTarget(ev.clientX, ev.clientY)
          setCursor('grabbing')
        }
        const up = () => {
          cleanup()
          if (cameraLock.controls) cameraLock.controls.enabled = !useOffice.getState().drag
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }}
      onClick={(e) => {
        e.stopPropagation()
        if (e.delta > DRAG_THRESHOLD_PX) return
        useOffice.getState().select({ kind: 'task', id })
      }}
    >
      <mesh geometry={ROUNDED} material={body} position={[0, h / 2, 0]} scale={[BOX_W, h, BOX_D]} castShadow receiveShadow raycast={raycast} />
      <mesh geometry={UNIT_BOX} material={band} position={[0, h - 0.07, 0]} scale={[BOX_W + 0.01, 0.035, BOX_D + 0.01]} castShadow raycast={raycast} />
      <mesh
        ref={outlineMesh}
        geometry={UNIT_BOX}
        position={[0, h / 2, 0]}
        scale={[BOX_W * 1.2, h * 1.12 + 0.05, BOX_D * 1.2]}
        material={outline}
        visible={false}
        raycast={noRaycast}
        renderOrder={5}
      />
    </group>
  )
})
