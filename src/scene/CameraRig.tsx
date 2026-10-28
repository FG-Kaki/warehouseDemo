// Orbit camera with limits, floor-clamped target, drag lock and fly-to-focus.
import { OrbitControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef, useState } from 'react'
import { MathUtils, PerspectiveCamera as ScratchCamera, TOUCH, Vector3, type PerspectiveCamera } from 'three'
import { useOffice } from '../store'
import { deskById, OFFICE } from '../office/layout'
import type { Selection } from '../store'
import { avatarLive, boxLive, cameraGesture, cameraLock, type ControlsImpl } from './runtime'

const TARGET0: [number, number, number] = [OFFICE.width / 2, 0, OFFICE.depth / 2]
const FOV = 23 // near-isometric
const MIN_DIST = 7
const MAX_DIST = 80
/** Share of the free area the office may span (the rest is margin). */
const SPAN = 0.94
const FOCUS_MEMBER = 12
const FOCUS_TASK = 14
const offset = new Vector3()
const dir = new Vector3()
const lastPos = new Vector3()
const lastTarget = new Vector3()
const prevOff = new Vector3()
/** A gesture counts as the user taking over the camera past these (a click's jitter stays below them). */
const MOVED_ANGLE = (1.5 * Math.PI) / 180
const MOVED_DIST = 0.015
const MOVED_TARGET = 0.1
const GESTURE_TAIL_MS = 800

// Office bounding box (floor, plinth and the tallest props) used to frame the whole thing.
const CORNERS: Vector3[] = []
for (const x of [0, OFFICE.width]) for (const y of [-0.3, 2.6]) for (const z of [0, OFFICE.depth]) CORNERS.push(new Vector3(x, y, z))
const scratch = new ScratchCamera(FOV, 1, 0.1, 300)
const corner = new Vector3()
const box = { w: 0, h: 0, cx: 0, cy: 0 }

/** Projected pixel extent / centre (relative to the view centre, y down) of the office seen from `dist` along `d`. */
function measure(dist: number, d: Vector3, tgt: Vector3, W: number, H: number) {
  scratch.fov = FOV
  scratch.aspect = W / H
  scratch.position.copy(tgt).addScaledVector(d, dist)
  scratch.lookAt(tgt)
  scratch.updateProjectionMatrix()
  scratch.updateMatrixWorld(true)
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (const c of CORNERS) {
    corner.copy(c).project(scratch)
    const px = (corner.x * W) / 2
    const py = (-corner.y * H) / 2
    if (px < x0) x0 = px
    if (px > x1) x1 = px
    if (py < y0) y0 = py
    if (py > y1) y1 = py
  }
  box.w = x1 - x0
  box.h = y1 - y0
  box.cx = (x0 + x1) / 2
  box.cy = (y0 + y1) / 2
}

/** Camera distance (along `d`) at which the whole office fits the free area, plus the pixel centre of the office then. */
function fitDistance(d: Vector3, tgt: Vector3, W: number, H: number, availW: number, availH: number) {
  let dist = 30
  for (let i = 0; i < 5; i++) {
    measure(dist, d, tgt, W, H)
    dist *= Math.max(box.w / (availW * SPAN), box.h / (availH * SPAN))
  }
  measure(dist, d, tgt, W, H)
  return { dist, cx: box.cx, cy: box.cy }
}

interface Fly {
  active: boolean
  tx: number
  ty: number
  tz: number
  dist: number
  follow: Selection | null
  t: number
}

/** Resolve where a focus target currently is. Returns false when unknown. */
function resolve(sel: Selection, out: Fly): boolean {
  if (sel.kind === 'member') {
    const live = avatarLive.get(sel.id)
    if (live && live.visible) {
      out.tx = live.x
      out.tz = live.z
      out.ty = 0.8
      return true
    }
    const m = useOffice.getState().members[sel.id]
    const desk = m ? deskById(m.deskId) : undefined
    if (desk) {
      out.tx = desk.x
      out.tz = desk.z
      out.ty = 0.8
      return true
    }
    return false
  }
  const b = boxLive.get(sel.id)
  if (!b) return false
  out.tx = b.x
  out.tz = b.z
  out.ty = Math.min(b.y, 1.2)
  return true
}

export function CameraRig() {
  const ref = useRef<ControlsImpl>(null)
  const camera = useThree((s) => s.camera) as PerspectiveCamera
  const size = useThree((s) => s.size)
  const gl = useThree((s) => s.gl)
  const insets = useOffice((s) => s.viewInsets)
  /** True once the camera was moved by the user (or a focus fly): from then on the distance is theirs. */
  const userMoved = useRef(false)
  const dragging = useOffice((s) => s.drag !== null)
  const focus = useOffice((s) => s.focus)
  const fly = useRef<Fly>({ active: false, tx: 0, ty: 0, tz: 0, dist: FOCUS_MEMBER, follow: null, t: 0 })
  const [maxDist, setMaxDist] = useState(MAX_DIST)
  // Framing goals; the camera eases toward them (distance) and the view offset eases toward its goal.
  const goal = useRef({ dist: 0, ox: 0, oy: 0, has: false })
  const curOff = useRef({ x: 0, y: 0 })
  /** Centring correction (px) measured while the user hadn't moved yet; frozen afterwards so nothing jumps. */
  const adj = useRef({ x: 0, y: 0 })
  const framed = useRef(false)
  // Gesture bookkeeping: the camera counts as "moved by the user" only when a gesture really moved it.
  const gesture = useRef({ active: false, until: 0, angle: 0, dist: 0, target: 0 })
  const snap = useRef({ pos: new Vector3(), tgt: new Vector3(), moved: false })
  const mountedAt = useRef(performance.now())

  useEffect(() => {
    cameraLock.controls = ref.current
    return () => {
      cameraLock.controls = null
    }
  }, [])

  // A touch press on a task box may nudge the orbit a few px before it turns into a pick-up: remember / undo that.
  useEffect(() => {
    cameraGesture.begin = () => {
      const c = ref.current
      if (!c) return
      snap.current.pos.copy(camera.position)
      snap.current.tgt.copy(c.target)
      snap.current.moved = userMoved.current
    }
    cameraGesture.discard = () => {
      const c = ref.current
      if (!c) return
      camera.position.copy(snap.current.pos)
      c.target.copy(snap.current.tgt)
      userMoved.current = snap.current.moved
      const g = gesture.current
      g.active = false
      g.until = 0
      lastPos.copy(camera.position)
      lastTarget.copy(c.target)
      c.update()
    }
    return () => {
      cameraGesture.begin = () => {}
      cameraGesture.discard = () => {}
    }
  }, [camera])

  // One finger / pen / mouse drag on the canvas must never scroll or zoom the page.
  useEffect(() => {
    const el = gl.domElement
    el.style.touchAction = 'none'
    const t = window.setTimeout(() => (el.style.touchAction = 'none'), 300)
    return () => window.clearTimeout(t)
  }, [gl])

  const applyOffset = (x: number, y: number, W: number, H: number) => {
    curOff.current.x = x
    curOff.current.y = y
    if (Math.abs(x) < 0.01 && Math.abs(y) < 0.01) camera.clearViewOffset()
    else camera.setViewOffset(W, H, -x, -y, W, H)
    camera.updateProjectionMatrix()
  }

  // Narrow FOV, office framed in the area not covered by HUD panels. The whole office (floor + walls) is projected
  // to find the distance that fits it with a margin (by width in portrait, by height in landscape) and the shift that
  // centres it in the free area. The first fit is instant; later ones (insets change, window resize) ease in useFrame.
  // After the user orbits/zooms only the centring follows the insets; the distance is theirs.
  useEffect(() => {
    const W = size.width
    const H = size.height
    if (W === 0 || H === 0) return
    camera.fov = FOV
    const availW = Math.max(240, W - insets.left - insets.right)
    const availH = Math.max(240, H - insets.top - insets.bottom)
    const fx = (insets.left - insets.right) / 2
    const fy = (insets.top - insets.bottom) / 2
    const c = ref.current
    const tgt = c ? c.target : new Vector3(TARGET0[0], TARGET0[1], TARGET0[2])
    if (!userMoved.current) {
      dir.copy(camera.position).sub(tgt)
      if (dir.lengthSq() < 1e-6) dir.set(0, 22, 21)
      dir.normalize()
      const f = fitDistance(dir, tgt, W, H, availW, availH)
      goal.current.dist = Math.max(MIN_DIST, f.dist)
      goal.current.has = true
      adj.current.x = -f.cx
      adj.current.y = -f.cy
      const max = Math.max(MAX_DIST, f.dist * 1.5)
      if (c) c.maxDistance = max
      setMaxDist(max)
    }
    goal.current.ox = fx + adj.current.x
    goal.current.oy = fy + adj.current.y
    const instant = !framed.current || performance.now() - mountedAt.current < 1200
    if (instant) {
      framed.current = true
      if (!userMoved.current && goal.current.has) {
        offset.copy(camera.position).sub(tgt)
        if (offset.lengthSq() < 1e-6) offset.set(0, 22, 21)
        offset.setLength(goal.current.dist)
        camera.position.copy(tgt).add(offset)
        c?.update()
      }
      applyOffset(goal.current.ox, goal.current.oy, W, H)
    } else {
      camera.updateProjectionMatrix()
    }
    lastPos.copy(camera.position)
    lastTarget.copy(tgt)
  }, [camera, size.width, size.height, insets])

  // Controls are off while a task is being dragged (from the scene or the panel).
  useEffect(() => {
    if (ref.current) ref.current.enabled = !dragging
  }, [dragging])

  useEffect(() => {
    if (!focus) return
    const f = fly.current
    if (resolve(focus.target, f)) {
      f.active = true
      userMoved.current = true
      f.follow = focus.target
      f.t = 0
      const want = focus.target.kind === 'member' ? FOCUS_MEMBER : FOCUS_TASK
      const cur = ref.current ? camera.position.distanceTo(ref.current.target) : want
      f.dist = MathUtils.clamp(Math.min(cur, want), MIN_DIST, MAX_DIST)
    }
    useOffice.getState().clearFocus()
  }, [focus, camera])

  useFrame((_, delta) => {
    const c = ref.current
    if (!c) return
    const dt = Math.min(delta, 0.1)
    const f = fly.current

    // Orbit/zoom/pan deltas since we last wrote the camera (our own writes are excluded) add up while a gesture is
    // running or settling (damping); a click or tap's few px of jitter stays under the thresholds.
    const g = gesture.current
    if (framed.current && !userMoved.current && (g.active || performance.now() < g.until)) {
      offset.copy(camera.position).sub(c.target)
      prevOff.copy(lastPos).sub(lastTarget)
      const len = offset.length()
      const plen = prevOff.length()
      if (len > 1e-6 && plen > 1e-6) {
        g.angle += offset.angleTo(prevOff)
        g.dist += Math.abs(len - plen) / plen
      }
      g.target += c.target.distanceTo(lastTarget)
      if (g.angle > MOVED_ANGLE || g.dist > MOVED_DIST || g.target > MOVED_TARGET) userMoved.current = true
    }

    // Smooth re-framing when the free area changes: ease the distance (until the user takes over) and the centring.
    if (framed.current && goal.current.has) {
      const k = 1 - Math.exp(-6 * dt)
      if (!userMoved.current && !f.active) {
        offset.copy(camera.position).sub(c.target)
        const len = offset.length()
        const dd = goal.current.dist - len
        if (Math.abs(dd) > 0.004 && len > 1e-6) {
          offset.setLength(Math.abs(dd) < 0.02 ? goal.current.dist : len + dd * k)
          camera.position.copy(c.target).add(offset)
        }
      }
      const ex = goal.current.ox - curOff.current.x
      const ey = goal.current.oy - curOff.current.y
      if (Math.abs(ex) > 0.01 || Math.abs(ey) > 0.01) {
        const snap = Math.abs(ex) < 0.3 && Math.abs(ey) < 0.3
        applyOffset(snap ? goal.current.ox : curOff.current.x + ex * k, snap ? goal.current.oy : curOff.current.y + ey * k, size.width, size.height)
      }
    }

    if (f.active) {
      if (f.follow) resolve(f.follow, f)
      const k = 1 - Math.exp(-5 * dt)
      const dx = (f.tx - c.target.x) * k
      const dy = (f.ty - c.target.y) * k
      const dz = (f.tz - c.target.z) * k
      c.target.x += dx
      c.target.y += dy
      c.target.z += dz
      camera.position.x += dx
      camera.position.y += dy
      camera.position.z += dz
      offset.copy(camera.position).sub(c.target)
      const len = offset.length()
      offset.setLength(len + (f.dist - len) * k)
      camera.position.copy(c.target).add(offset)
      f.t += dt
      const rem = Math.hypot(f.tx - c.target.x, f.tz - c.target.z)
      if ((rem < 0.05 && Math.abs(len - f.dist) < 0.15) || f.t > 3) f.active = false
    }

    // Keep the look-at point over the floor; shift the camera by the same amount.
    const cx = MathUtils.clamp(c.target.x, 0, OFFICE.width)
    const cz = MathUtils.clamp(c.target.z, 0, OFFICE.depth)
    const cy = MathUtils.clamp(c.target.y, 0, 1.5)
    const ox = cx - c.target.x
    const oy = cy - c.target.y
    const oz = cz - c.target.z
    if (ox !== 0 || oy !== 0 || oz !== 0) {
      c.target.set(cx, cy, cz)
      camera.position.x += ox
      camera.position.y += oy
      camera.position.z += oz
    }
    lastPos.copy(camera.position)
    lastTarget.copy(c.target)
  })

  return (
    <OrbitControls
      ref={ref}
      makeDefault
      target={TARGET0}
      enableDamping
      zoomToCursor
      dampingFactor={0.09}
      rotateSpeed={0.7}
      panSpeed={0.9}
      zoomSpeed={0.8}
      screenSpacePanning={false}
      minPolarAngle={MathUtils.degToRad(20)}
      maxPolarAngle={MathUtils.degToRad(70)}
      minDistance={MIN_DIST}
      maxDistance={maxDist}
      touches={{ ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN }}
      onStart={() => {
        fly.current.active = false
        const g = gesture.current
        g.active = true
        g.angle = g.dist = g.target = 0
      }}
      onEnd={() => {
        const g = gesture.current
        g.active = false
        g.until = performance.now() + GESTURE_TAIL_MS
      }}
    />
  )
}
