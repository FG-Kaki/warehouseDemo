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

export function setCursor(cursor: string) {
  document.body.style.cursor = cursor
}

export const noRaycast = () => null

/** Latest R3F state getter (camera, canvas, ...), set by DragLayer so plain DOM handlers can raycast. */
export const sceneApi: { get: (() => RootState) | null } = { get: null }

/** Layer for moving things (bots, boxes, diamonds, ghosts). Static furniture stays on layer 0 so ContactShadows can bake once. */
export const DYN_LAYER = 1
