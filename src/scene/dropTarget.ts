// Synchronous drop-target hit test: pointer (client px) → ray vs tall boxes → member desk/avatar, backlog shelf or meeting table.
// Called from DOM event handlers (never from useFrame) so the target is always current when pointerup lands.
import { Box3, Plane, Ray, Raycaster, Vector2, Vector3 } from 'three'
import { OFFICE } from '../office/layout'
import { useOffice, type DropTarget } from '../store'
import { BACKLOG_CENTER_X, TABLE_TOP_Y } from './Furniture'
import { ROOMS } from './paths'
import { avatarLive, DRAG_Y, dragPoint, sceneApi } from './runtime'

const ray = new Raycaster()
const ndc = new Vector2()
const planeDrag = new Plane(new Vector3(0, 1, 0), -DRAG_Y)
const tmpBox = new Box3()
const localRay = new Ray()
// Desk footprint + chair area in desk-local space (+z = monitor side), up to 3 m tall.
const deskBox = new Box3(new Vector3(-1.05, 0, -1.6), new Vector3(1.05, 3, 0.8))
// Meeting table + a small margin, low enough that a ray aimed at an attendee's body hits the bot first.
const MT = ROOMS.meeting
const tableBox = new Box3(
  new Vector3(MT.cx - MT.tableW / 2 - 0.25, 0, MT.cz - MT.tableD / 2 - 0.2),
  new Vector3(MT.cx + MT.tableW / 2 + 0.25, TABLE_TOP_Y + 0.25, MT.cz + MT.tableD / 2 + 0.2),
)
// Rest of the room floor: only used when nothing else (bot, desk, shelf) was under the pointer at all.
const MR = OFFICE.meetingRoom
const roomBox = new Box3(new Vector3(MR.x, 0, MR.z), new Vector3(MR.x + MR.w, 0.6, MR.z + MR.d))
const hitA = new Vector3()
const hitB = new Vector3()

/** undefined = nothing published yet this drag, so the first hit always overwrites a stale (panel) target. */
let last: DropTarget | null | undefined

export function resetDropTracking() {
  last = undefined
}

function sameTarget(a: DropTarget | null | undefined, b: DropTarget | null) {
  if (a === undefined) return false
  if (a === null || b === null) return a === b
  if (a.kind !== b.kind) return false
  return a.kind !== 'member' || (b.kind === 'member' && a.id === b.id)
}

function publish(t: DropTarget | null) {
  if (sameTarget(last, t)) return
  last = t
  useOffice.getState().setDropTarget(t)
}

/** Clear the scene's claim (pointer left the canvas); the panel may set its own target next. */
export function clearSceneTarget() {
  dragPoint.active = false
  publish(null)
  last = undefined
}

/** Update dragPoint and the drop target from a client-space pointer position over the canvas. */
export function updateDropTarget(clientX: number, clientY: number) {
  const api = sceneApi.get?.()
  if (!api) return
  const rect = api.gl.domElement.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return
  ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
  // The camera's projection includes any view offset, so this stays consistent with what is drawn.
  ray.setFromCamera(ndc, api.camera)

  if (ray.ray.intersectPlane(planeDrag, hitA)) {
    dragPoint.x = hitA.x
    dragPoint.y = DRAG_Y
    dragPoint.z = hitA.z
    dragPoint.active = true
  }

  // Nearest hit of the pointer ray against tall boxes wins: a bot, an occupied desk (footprint + chair area),
  // or the backlog shelf. Boxes are tall so pointing at a stack of task boxes hits the right desk.
  let target: DropTarget | null = null
  let best = Infinity
  const members = useOffice.getState().members
  const o = ray.ray.origin
  const dir = ray.ray.direction

  for (const [id, live] of avatarLive) {
    if (!live.visible || !members[id]) continue
    tmpBox.min.set(live.x - 0.45, 0, live.z - 0.45)
    tmpBox.max.set(live.x + 0.45, 1.7, live.z + 0.45)
    if (ray.ray.intersectBox(tmpBox, hitB)) {
      const t = o.distanceTo(hitB)
      if (t < best) {
        best = t
        target = { kind: 'member', id }
      }
    }
  }

  for (const d of OFFICE.desks) {
    let owner: string | null = null
    for (const id in members) {
      if (members[id].deskId === d.id) {
        owner = id
        break
      }
    }
    if (!owner) continue // free desks are not drop targets
    // Ray into desk-local space (rotation about Y by `facing`), then test a tall box there.
    const c = Math.cos(d.facing)
    const sn = Math.sin(d.facing)
    const ox = o.x - d.x
    const oz = o.z - d.z
    localRay.origin.set(ox * c - oz * sn, o.y, ox * sn + oz * c)
    localRay.direction.set(dir.x * c - dir.z * sn, dir.y, dir.x * sn + dir.z * c)
    if (localRay.intersectBox(deskBox, hitB)) {
      const t = localRay.origin.distanceTo(hitB)
      if (t < best) {
        best = t
        target = { kind: 'member', id: owner }
      }
    }
  }

  const A = OFFICE.backlogShelf
  tmpBox.min.set(BACKLOG_CENTER_X - 0.6, 0, A.z - 0.1)
  tmpBox.max.set(BACKLOG_CENTER_X + 0.6, 3, A.z + A.d + 0.1)
  if (ray.ray.intersectBox(tmpBox, hitB) && o.distanceTo(hitB) < best) {
    best = o.distanceTo(hitB)
    target = { kind: 'backlog' }
  }

  // Meeting table: only for open tasks that aren't on the agenda yet (dropping back on it is a no-op).
  const drag = useOffice.getState().drag
  const dragged = drag ? useOffice.getState().tasks[drag.taskId] : undefined
  if (dragged && dragged.status !== 'done' && !dragged.onAgenda) {
    if (ray.ray.intersectBox(tableBox, hitB) && o.distanceTo(hitB) < best) target = { kind: 'agenda' }
    else if (target === null && ray.ray.intersectBox(roomBox, hitB)) target = { kind: 'agenda' }
  }
  publish(target)
}

/** True when the client point is over the 3D canvas itself (not a HUD element on top of it). */
export function isOverCanvas(clientX: number, clientY: number): boolean {
  const api = sceneApi.get?.()
  if (!api) return false
  return document.elementFromPoint(clientX, clientY) === api.gl.domElement
}
