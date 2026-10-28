// While a task is being dragged (from the scene or the panel): hit-test the drop target synchronously from
// pointer events on the canvas (so a quick flick still lands before pointerup), and show a ghost box for panel drags.
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import type { Mesh } from 'three'
import { PRIORITY_META } from '../data/meta'
import { useOffice } from '../store'
import { clearSceneTarget, isOverCanvas, resetDropTracking, updateDropTarget } from './dropTarget'
import { dragPoint, sceneApi, setCursor } from './runtime'
import { useDynamicLayer } from './shared'
import { BOX_D, BOX_W, boxHeight } from './slots'

export function DragLayer() {
  const drag = useOffice((s) => s.drag)
  const task = useOffice((s) => (s.drag ? s.tasks[s.drag.taskId] : undefined))
  const get = useThree((s) => s.get)
  const gl = useThree((s) => s.gl)
  const ghost = useRef<Mesh>(null)
  useDynamicLayer(ghost)

  useEffect(() => {
    sceneApi.get = get
    return () => {
      if (sceneApi.get === get) sceneApi.get = null
    }
  }, [get])

  useEffect(() => {
    if (!drag) {
      dragPoint.active = false
      resetDropTracking()
      setCursor('')
      return
    }
    // A panel drag has to claim the target the first time the pointer is over the 3D view.
    if (drag.from === 'panel') {
      dragPoint.active = false
      resetDropTracking()
    }
    const el = gl.domElement
    // Window-level on purpose: a drag started in the panel (or by touch) keeps delivering pointer events to the
    // element that received the pointerdown, never to the canvas, so the canvas can't be the one listening.
    let over = drag.from === 'scene'
    // Only the primary pointer steers the drop target: a second finger or a palm must not redirect it.
    const track = (e: PointerEvent) => {
      if (!e.isPrimary) return
      if (isOverCanvas(e.clientX, e.clientY)) {
        over = true
        updateDropTarget(e.clientX, e.clientY)
      } else if (over) {
        over = false
        clearSceneTarget()
        if (ghost.current) ghost.current.visible = false
      }
    }
    // Capture phase: runs before App's pointerup handler applies the drop.
    const up = (e: PointerEvent) => {
      if (!e.isPrimary) return
      if (isOverCanvas(e.clientX, e.clientY)) updateDropTarget(e.clientX, e.clientY)
    }
    // The browser took over the gesture (touch scroll, system gesture): give up instead of leaving a stuck drag.
    const cancel = (e: PointerEvent) => {
      if (e.isPrimary) useOffice.getState().cancelDrag()
    }
    const noMenu = (e: Event) => e.preventDefault()
    window.addEventListener('pointermove', track)
    window.addEventListener('pointerdown', track)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', cancel)
    el.addEventListener('contextmenu', noMenu)
    return () => {
      window.removeEventListener('pointermove', track)
      window.removeEventListener('pointerdown', track)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', cancel)
      el.removeEventListener('contextmenu', noMenu)
      dragPoint.active = false
    }
  }, [drag, gl])

  // The ghost only follows the already-computed pointer point.
  useFrame(() => {
    const g = ghost.current
    if (!g || !drag) return
    g.visible = dragPoint.active
    if (dragPoint.active) g.position.set(dragPoint.x, dragPoint.y, dragPoint.z)
  })

  if (!drag || drag.from !== 'panel' || !task) return null
  const h = boxHeight(task.estimate)
  return (
    <mesh ref={ghost} visible={false} scale={[BOX_W * 1.1, h, BOX_D * 1.1]} renderOrder={6}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={PRIORITY_META[task.priority].color} transparent opacity={0.8} depthWrite={false} />
    </mesh>
  )
}
