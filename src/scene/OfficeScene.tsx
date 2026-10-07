// OWNER: scene-builder. Root of everything rendered inside <Canvas>.
import { Avatars } from './Avatars'
import { CameraRig } from './CameraRig'
import { Decor } from './Furniture'
import { Desks } from './Desks'
import { DragLayer } from './DragLayer'
import { Lighting } from './Lighting'
import { MeetingRoomState } from './MeetingRoomState'
import { Overlays } from './Overlays'
import { Room } from './Room'
import { TaskBoxes } from './TaskBoxes'
import { TaskTooltip } from './TaskTooltip'
import { DRAG_THRESHOLD_PX } from './runtime'
import { NoPick } from './shared'
import { useOffice } from '../store'
import { OFFICE } from '../office/layout'

export function OfficeScene() {
  return (
    <>
      <Lighting />
      <CameraRig />
      {/* Anything that doesn't stop propagation lands here: a click on empty floor / furniture clears the selection. */}
      <group
        onClick={(e) => {
          if (e.delta > DRAG_THRESHOLD_PX) return
          const s = useOffice.getState()
          if (s.drag) return
          if (s.selection) s.select(null)
        }}
      >
        {/* Large invisible ground so clicks outside the room count too. */}
        <mesh position={[OFFICE.width / 2, -0.45, OFFICE.depth / 2]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[200, 200]} />
          <meshBasicMaterial visible={false} />
        </mesh>
        <NoPick>
          <Room />
          <Decor />
          <Desks />
        </NoPick>
        <Avatars />
        <TaskBoxes />
        <Overlays />
        <MeetingRoomState />
      </group>
      <TaskTooltip />
      <DragLayer />
    </>
  )
}
