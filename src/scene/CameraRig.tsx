// Orbit camera with limits, floor-clamped target, drag lock and fly-to-focus.
import { OrbitControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { MathUtils, Vector3, type PerspectiveCamera } from 'three'
import { useOffice } from '../store'
import { deskById, OFFICE } from '../office/layout'
import type { Selection } from '../store'
import { avatarLive, boxLive, cameraLock, type ControlsImpl } from './runtime'

const TARGET0: [number, number, number] = [OFFICE.width / 2, 0, OFFICE.depth / 2]
const FOV = 23 // near-isometric
const MIN_DIST = 7
const MAX_DIST = 80
const FOCUS_MEMBER = 12
const FOCUS_TASK = 14
/** Rough screen footprint of the office at the default angle (world units), used to frame it. */
const FIT_W = 29
const FIT_H = 17.5
const offset = new Vector3()

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
  const insets = useOffice((s) => s.viewInsets)
  const userMoved = useRef(false)
  const dragging = useOffice((s) => s.drag !== null)
  const focus = useOffice((s) => s.focus)
  const fly = useRef<Fly>({ active: false, tx: 0, ty: 0, tz: 0, dist: FOCUS_MEMBER, follow: null, t: 0 })

  useEffect(() => {
    cameraLock.controls = ref.current
    return () => {
      cameraLock.controls = null
    }
  }, [])

  // Narrow FOV, office framed in the area not covered by HUD panels: shift the projection centre with a
  // view offset (picking uses the same projection, so it stays aligned) and, until the user takes over, fit the distance.
  useEffect(() => {
    const W = size.width
    const H = size.height
    if (W === 0 || H === 0) return
    camera.fov = FOV
    const availW = Math.max(240, W - insets.left - insets.right)
    const availH = Math.max(240, H - insets.top - insets.bottom)
    const sx = (insets.left - insets.right) / 2
    const sy = (insets.top - insets.bottom) / 2
    if (sx === 0 && sy === 0) camera.clearViewOffset()
    else camera.setViewOffset(W, H, -sx, -sy, W, H)
    if (!userMoved.current) {
      const ppu = Math.min(availW / FIT_W, availH / FIT_H)
      const d = MathUtils.clamp(H / (2 * Math.tan(MathUtils.degToRad(FOV / 2)) * ppu), MIN_DIST, MAX_DIST)
      const c = ref.current
      const tgt = c ? c.target : new Vector3(TARGET0[0], TARGET0[1], TARGET0[2])
      offset.copy(camera.position).sub(tgt)
      if (offset.lengthSq() < 1e-6) offset.set(0, 22, 21)
      offset.setLength(d)
      camera.position.copy(tgt).add(offset)
      c?.update()
    }
    camera.updateProjectionMatrix()
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
    const dt = Math.min(delta, 0.05)
    const f = fly.current

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
      maxDistance={MAX_DIST}
      onStart={() => {
        fly.current.active = false
        userMoved.current = true
      }}
    />
  )
}
