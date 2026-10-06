// Static office floor plan, in meters (1 world unit = 1 m). Owned by the architect.
// x → east, z → south, y up. Floor spans x ∈ [0, OFFICE.width], z ∈ [0, OFFICE.depth].
// A desk's `facing` is the direction the seated person looks (radians around +Y, 0 = +z).

export interface DeskSpot {
  id: string
  /** Desk center. */
  x: number
  z: number
  facing: number
  /** Pod label for grouping in the UI. */
  pod: 'A' | 'B'
}

export interface Area {
  x: number
  z: number
  w: number
  d: number
}

const N = Math.PI // facing north (-z)
const S = 0 // facing south (+z)

export const OFFICE = {
  width: 26,
  depth: 18,
  wallHeight: 3,
  /** Two pods of desks facing each other across a shared table line. */
  desks: [
    { id: 'A1', x: 7, z: 6, facing: S, pod: 'A' },
    { id: 'A2', x: 9, z: 6, facing: S, pod: 'A' },
    { id: 'A3', x: 11, z: 6, facing: S, pod: 'A' },
    { id: 'A4', x: 7, z: 8, facing: N, pod: 'A' },
    { id: 'A5', x: 9, z: 8, facing: N, pod: 'A' },
    { id: 'B1', x: 7, z: 12, facing: S, pod: 'B' },
    { id: 'B2', x: 9, z: 12, facing: S, pod: 'B' },
    { id: 'B3', x: 11, z: 12, facing: S, pod: 'B' },
    { id: 'B4', x: 7, z: 14, facing: N, pod: 'B' },
    { id: 'B5', x: 9, z: 14, facing: N, pod: 'B' },
  ] as DeskSpot[],
  /** Desk footprint (w along x, d along z). The chair sits behind the desk opposite `facing`. */
  deskSize: { w: 1.8, d: 1.2 },
  /** Glass-walled meeting room, north-east. */
  meetingRoom: { x: 16, z: 1.5, w: 8, d: 6 } as Area,
  /** Sofas, coffee machine, plants, south-east. */
  lounge: { x: 16, z: 11, w: 8, d: 5.5 } as Area,
  /** Unassigned tasks shelf, by the entrance on the west wall. */
  backlogShelf: { x: 1, z: 4, w: 1.2, d: 6 } as Area,
  /** "Done" shelf / trophy wall, north wall. */
  doneShelf: { x: 4, z: 0.4, w: 8, d: 0.8 } as Area,
  /** Entrance door on the west wall (gap in the wall), where new members walk in. */
  entrance: { x: 0, z: 13, w: 0.2, d: 2.4 } as Area,
} as const

export const MAX_MEMBERS = OFFICE.desks.length

export function deskById(id: string): DeskSpot | undefined {
  return OFFICE.desks.find((d) => d.id === id)
}
