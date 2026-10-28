// Mutable, per-frame shared state between scene components. Never reactive — read inside useFrame / handlers only.
import type { RootState } from '@react-three/fiber'
import type { ComponentRef } from 'react'
import type { OrbitControls } from '@react-three/drei'
import type { Id } from '../data/types'

export type ControlsImpl = ComponentRef<typeof OrbitControls>

/** Live avatar position (updated every frame by each Avatar). */
export interface AvatarLive {
  x: number
  z: number
  visible: boolean
}
export const avatarLive = new Map<Id, AvatarLive>()

/** Live task box world position (updated every frame by each TaskBox). */
export interface BoxLive {
  x: number
  y: number
  z: number
}
export const boxLive = new Map<Id, BoxLive>()

/** Where the dragged box should be (pointer on the y = DRAG_Y plane). */
export const DRAG_Y = 1.5
export const dragPoint = { x: 0, y: DRAG_Y, z: 0, active: false }

/** Lets a box lock the orbit controls synchronously on pointerdown. */
export const cameraLock: { controls: ControlsImpl | null } = { controls: null }

/** Pixels the pointer must move after pointerdown before a click turns into a drag. */
export const DRAG_THRESHOLD_PX = 4

/** CameraRig hooks for gestures that start on a box: remember the camera before, undo the tiny swing after. */
export const cameraGesture: { begin: () => void; discard: () => void } = { begin: () => {}, discard: () => {} }

/**
 * Hand a pointer back to the page once a task drag begins. OrbitControls captures the pointer on its element (and touch
 * has implicit capture), so without this every move keeps going to the canvas and panel drop targets never see the
 * pointer; OrbitControls must also forget the pointer or the next one-finger touch is treated as a pinch.
 */
export function releaseCanvasPointer(pointerId: number) {
  const els: (HTMLElement | undefined)[] = [cameraLock.controls?.domElement, sceneApi.get?.().gl.domElement]
  const controls = cameraLock.controls
  if (controls) {
    try {
      // Non-bubbling, so it reaches OrbitControls' own listener but not our window-level drag listeners.
      controls.domElement?.dispatchEvent(new PointerEvent('pointercancel', { pointerId, bubbles: false }))
    } catch {
      // Ignore: the controls just keep a stale pointer until its next pointerup.
    }
  }
  for (const el of els) {
    try {
      if (el?.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId)
    } catch {
      // Not captured / pointer already gone.
    }
  }
}

/** Touch is shakier than a mouse: a tap may wobble this far and still be a click. */
export function clickSlop(e: { nativeEvent?: unknown } | undefined): number {
  const t = (e?.nativeEvent as { pointerType?: string } | undefined)?.pointerType
  return t === 'touch' ? 14 : DRAG_THRESHOLD_PX
}

/** Touch: how long a finger must rest on a task box before it picks the box up (otherwise it orbits). */
export const LONG_PRESS_MS = 300
/** Touch: the finger may drift this far (px) during the long-press before it counts as an orbit gesture. */
export const LONG_PRESS_SLOP_PX = 9

/** Coarse pointer (tablet / phone) or little device memory: render cheaper. Desktop is unchanged. */
export const LOW_POWER =
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(pointer: coarse)').matches === true || ((navigator as { deviceMemory?: number }).deviceMemory ?? 8) <= 4)

export function setCursor(cursor: string) {
  document.body.style.cursor = cursor
}

export const noRaycast = () => null

/** Latest R3F state getter (camera, canvas, ...), set by DragLayer so plain DOM handlers can raycast. */
export const sceneApi: { get: (() => RootState) | null } = { get: null }

/** Layer for moving things (bots, boxes, diamonds, ghosts). Static furniture stays on layer 0 so ContactShadows can bake once. */
export const DYN_LAYER = 1
