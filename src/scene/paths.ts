// Walkable waypoint graph + seat/spot definitions, all derived from OFFICE geometry.
import { OFFICE, type DeskSpot } from '../office/layout'

export interface Pt {
  x: number
  z: number
}

/** A place an avatar can stand/sit. `node` = approach node in the graph (or -1). */
export interface Spot {
  x: number
  z: number
  /** Yaw (radians around +Y, 0 = +z). */
  facing: number
  seated: boolean
  node: number
  /** Leaving the building: avatar fades out and hides on arrival. */
  exit?: boolean
}

// ---- Layout constants shared with furniture ----------------------------------

export const CHAIR_OFFSET = 0.95
const MEETING = OFFICE.meetingRoom
const LOUNGE = OFFICE.lounge
const ENTR = OFFICE.entrance

export const ROOMS = {
  meeting: {
    cx: MEETING.x + MEETING.w / 2,
    cz: MEETING.z + MEETING.d / 2,
    tableW: 4.2,
    tableD: 1.2,
    doorZ: MEETING.z + 2.3,
    doorHalf: 0.8,
  },
  lounge: {
    cx: LOUNGE.x + LOUNGE.w / 2,
    cz: LOUNGE.z + LOUNGE.d / 2,
    sofaNorthZ: LOUNGE.z + 0.9,
    sofaSouthZ: LOUNGE.z + LOUNGE.d - 0.9,
    sofaW: 4,
    sofaD: 0.95,
    tableW: 2.2,
    tableD: 0.9,
    machineX: LOUNGE.x + LOUNGE.w - 0.5,
    machineZ: LOUNGE.z + LOUNGE.d / 2 - 0.75,
  },
  entrance: { cz: ENTR.z + ENTR.d / 2 },
} as const

// ---- Graph --------------------------------------------------------------------

export const NODES: Pt[] = []
const adj: number[][] = []

function nodeAt(x: number, z: number): number {
  for (let i = 0; i < NODES.length; i++) {
    if (Math.abs(NODES[i].x - x) < 0.1 && Math.abs(NODES[i].z - z) < 0.1) return i
  }
  NODES.push({ x, z })
  adj.push([])
  return NODES.length - 1
}

function link(a: number, b: number) {
  if (a === b || adj[a].includes(b)) return
  adj[a].push(b)
  adj[b].push(a)
}

function chain(ids: number[]) {
  for (let i = 1; i < ids.length; i++) link(ids[i - 1], ids[i])
}

const uniqSorted = (v: number[]) => [...new Set(v.map((n) => Math.round(n * 100) / 100))].sort((a, b) => a - b)

export function chairPos(d: DeskSpot): Pt {
  return { x: d.x - Math.sin(d.facing) * CHAIR_OFFSET, z: d.z - Math.cos(d.facing) * CHAIR_OFFSET }
}

const deskXs = uniqSorted(OFFICE.desks.map((d) => d.x))
const chairZs = uniqSorted(OFFICE.desks.map((d) => chairPos(d).z))

let aisleZ = (chairZs[0] + chairZs[chairZs.length - 1]) / 2
{
  let best = 0
  for (let i = 1; i < chairZs.length; i++) {
    const gap = chairZs[i] - chairZs[i - 1]
    if (gap > best) {
      best = gap
      aisleZ = (chairZs[i] + chairZs[i - 1]) / 2
    }
  }
}
const northZ = chairZs[0] - 1.2
const southZ = Math.min(chairZs[chairZs.length - 1] + 1.4, OFFICE.depth - 0.9)
const westX = deskXs[0] - 3
const eastX = deskXs[deskXs.length - 1] + 3
const corridorZs = [northZ, aisleZ, southZ]

const entranceZ = ROOMS.entrance.cz
export const ENTRANCE_IN: Pt = { x: ENTR.x + 1.0, z: entranceZ }
export const ENTRANCE_OUT: Pt = { x: ENTR.x - 1.8, z: entranceZ }

// Corridor rows (west → east).
const rowXs = [westX, ...deskXs, eastX]
for (const z of corridorZs) chain(rowXs.map((x) => nodeAt(x, z)))

// West column (between shelf and pods) and east column (between pods and rooms).
chain(uniqSorted([northZ, aisleZ, entranceZ, southZ]).map((z) => nodeAt(westX, z)))
const doorZ = ROOMS.meeting.doorZ
chain(uniqSorted([northZ, doorZ, aisleZ, ROOMS.lounge.cz, southZ]).map((z) => nodeAt(eastX, z)))

export const ENTRANCE_NODE = nodeAt(ENTRANCE_IN.x, ENTRANCE_IN.z)
link(ENTRANCE_NODE, nodeAt(westX, entranceZ))

// Meeting room ring.
const mr = ROOMS.meeting
const mrWestX = MEETING.x + 0.9
const mrEastX = MEETING.x + MEETING.w - 0.9
const mrNorthZ = mr.cz - 2.1
const mrSouthZ = mr.cz + 2.1
const seatDX = [-1.5, -0.5, 0.5, 1.5]
const mrXs = seatDX.map((d) => mr.cx + d)
const nRow = [mrWestX, ...mrXs, mrEastX].map((x) => nodeAt(x, mrNorthZ))
const sRow = [mrWestX, ...mrXs, mrEastX].map((x) => nodeAt(x, mrSouthZ))
const mrW = nodeAt(mrWestX, mr.cz)
const mrE = nodeAt(mrEastX, mr.cz)
const mrDoor = nodeAt(mrWestX, doorZ)
chain(nRow)
chain(sRow)
chain([nRow[0], mrDoor, mrW, sRow[0]])
chain([nRow[nRow.length - 1], mrE, sRow[sRow.length - 1]])
link(mrDoor, nodeAt(eastX, doorZ))

// Lounge ring.
const lg = ROOMS.lounge
const lgWestX = LOUNGE.x + 1.6
const lgEastX = LOUNGE.x + LOUNGE.w - 1.6
const lgNorthRowZ = lg.sofaNorthZ + 1.0
const lgSouthRowZ = lg.sofaSouthZ - 1.0
const lgXs = [lg.cx - 1, lg.cx, lg.cx + 1]
const lnRow = [lgWestX, ...lgXs, lgEastX].map((x) => nodeAt(x, lgNorthRowZ))
const lsRow = [lgWestX, ...lgXs, lgEastX].map((x) => nodeAt(x, lgSouthRowZ))
const lgW = nodeAt(lgWestX, lg.cz)
const lgE = nodeAt(lgEastX, lg.cz)
chain(lnRow)
chain(lsRow)
chain([lnRow[0], lgW, lsRow[0]])
chain([lnRow[lnRow.length - 1], lgE, lsRow[lsRow.length - 1]])
link(lgW, nodeAt(eastX, lg.cz))

// ---- Shortest path ---------------------------------------------------------------

const routeCache = new Map<number, number[]>()

/** Node indices from `from` to `to`, inclusive. */
export function findRoute(from: number, to: number): number[] {
  if (from === to) return [from]
  const key = from * 1000 + to
  const hit = routeCache.get(key)
  if (hit) return hit
  const n = NODES.length
  const dist = new Array<number>(n).fill(Infinity)
  const prev = new Array<number>(n).fill(-1)
  const done = new Array<boolean>(n).fill(false)
  dist[from] = 0
  for (let iter = 0; iter < n; iter++) {
    let u = -1
    for (let i = 0; i < n; i++) if (!done[i] && (u === -1 || dist[i] < dist[u])) u = i
    if (u === -1 || dist[u] === Infinity) break
    done[u] = true
    if (u === to) break
    for (const v of adj[u]) {
      const w = Math.hypot(NODES[u].x - NODES[v].x, NODES[u].z - NODES[v].z)
      if (dist[u] + w < dist[v]) {
        dist[v] = dist[u] + w
        prev[v] = u
      }
    }
  }
  const out: number[] = []
  for (let c = to; c !== -1; c = prev[c]) out.push(c)
  out.reverse()
  const res = out[0] === from ? out : [from, to]
  routeCache.set(key, res)
  return res
}

// ---- Spots -----------------------------------------------------------------------

const spotCache = new Map<string, Spot>()
function cached(key: string, make: () => Spot): Spot {
  let s = spotCache.get(key)
  if (!s) {
    s = make()
    spotCache.set(key, s)
  }
  return s
}

export function deskIndex(deskId: string, fallbackKey = ''): number {
  const i = OFFICE.desks.findIndex((d) => d.id === deskId)
  if (i >= 0) return i
  let h = 0
  for (let k = 0; k < fallbackKey.length; k++) h = (h * 31 + fallbackKey.charCodeAt(k)) >>> 0
  return h % OFFICE.desks.length
}

/** Seat of a desk's chair; null for an unknown desk id. */
export function deskSeat(deskId: string): Spot | null {
  const d = OFFICE.desks.find((x) => x.id === deskId)
  if (!d) return null
  return cached(`desk:${deskId}`, () => {
    const c = chairPos(d)
    const sign = -Math.cos(d.facing) >= 0 ? 1 : -1
    let best = corridorZs[0]
    let bestD = Infinity
    for (const z of corridorZs) {
      if ((z - c.z) * sign > 0.3 && Math.abs(z - c.z) < bestD) {
        best = z
        bestD = Math.abs(z - c.z)
      }
    }
    if (bestD === Infinity) {
      for (const z of corridorZs) if (Math.abs(z - c.z) < bestD) { best = z; bestD = Math.abs(z - c.z) }
    }
    return {
      x: c.x + Math.sin(d.facing) * 0.06,
      z: c.z + Math.cos(d.facing) * 0.06,
      facing: d.facing,
      seated: true,
      node: nodeAt(d.x, best),
    }
  })
}

const MEETING_SEATS = 10
export function meetingSeat(i: number): Spot {
  const k = ((i % MEETING_SEATS) + MEETING_SEATS) % MEETING_SEATS
  return cached(`meet:${k}`, () => {
    const rowOff = ROOMS.meeting.tableD / 2 + 0.6
    if (k < 4) return { x: mrXs[k], z: mr.cz - rowOff, facing: 0, seated: true, node: nRow[k + 1] }
    if (k < 8) return { x: mrXs[k - 4], z: mr.cz + rowOff, facing: Math.PI, seated: true, node: sRow[k - 3] }
    const endOff = ROOMS.meeting.tableW / 2 + 0.55
    if (k === 8) return { x: mr.cx - endOff, z: mr.cz, facing: Math.PI / 2, seated: true, node: mrW }
    return { x: mr.cx + endOff, z: mr.cz, facing: -Math.PI / 2, seated: true, node: mrE }
  })
}

const LOUNGE_SPOTS = 10
export function loungeSpot(i: number): Spot {
  const k = ((i % LOUNGE_SPOTS) + LOUNGE_SPOTS) % LOUNGE_SPOTS
  return cached(`lounge:${k}`, () => {
    if (k < 3) return { x: lgXs[k], z: lg.sofaNorthZ + 0.1, facing: 0, seated: true, node: lnRow[k + 1] }
    if (k < 6) return { x: lgXs[k - 3], z: lg.sofaSouthZ - 0.1, facing: Math.PI, seated: true, node: lsRow[k - 2] }
    const mx = lg.machineX - 0.9
    if (k === 6) return { x: mx, z: lg.machineZ + 0.2, facing: Math.PI / 2, seated: false, node: lgE }
    if (k === 7) return { x: mx, z: lg.machineZ + 1.3, facing: Math.PI / 2, seated: false, node: lgE }
    if (k === 8) return { x: lg.cx - lg.tableW / 2 - 0.6, z: lg.cz, facing: Math.PI / 2, seated: false, node: lgW }
    return { x: lg.cx + lg.tableW / 2 + 0.6, z: lg.cz, facing: -Math.PI / 2, seated: false, node: lgE }
  })
}

export const EXIT_SPOT: Spot = {
  x: ENTRANCE_OUT.x,
  z: ENTRANCE_OUT.z,
  facing: -Math.PI / 2,
  seated: false,
  node: ENTRANCE_NODE,
  exit: true,
}
