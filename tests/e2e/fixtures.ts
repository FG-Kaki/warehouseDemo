// Shared fixtures and helpers for the e2e suite (OWNER: qa-engineer).
//
// Conventions
// - `source` (option, set by the project): 'mock' opens `/`, 'api' opens `/?source=api`.
// - Every test gets a fresh browser context (fresh localStorage); demo mode is switched off before the page
//   loads (mock: the 'office-dashboard:demo' preference, api: PUT /api/demo) and the API data is reset.
// - Any console.error / uncaught page error fails the test (set `allowConsoleErrors: true` to opt out).
// - State is read through the zustand store (`/src/store.ts`) inside the page; nothing is added to the app.
// - 3D targeting: the scene exports its live box/avatar positions and the R3F state getter (`/src/scene/runtime.ts`).
//   We project those world positions with the real camera matrices to screen pixels, then drive the REAL mouse.
//   Boxes are confirmed by hovering until `store.hover` is the task (probing a few pixels around the projection),
//   drop targets by moving until `store.dropTarget` is what we want. No private hooks, no fixed sleeps.
import { test as base, expect, type APIRequestContext, type BrowserContext, type Locator, type Page } from '@playwright/test'
import type { Task, Workspace } from '../../src/data/types'
import { API_URL } from './env'

export type Source = 'mock' | 'api'

export interface OfficeOptions {
  source: Source
  /** Skip the "no console errors" check (tests that break the server on purpose). */
  allowConsoleErrors: boolean
}

interface OfficeFixtures {
  /** Direct, hygiene-compliant client of the e2e API (JSON content type, 127.0.0.1 Host). */
  api: APIRequestContext
}

/** Only deprecations/noise that are not app errors (they are console warnings today, listed to be explicit). */
const KNOWN_NOISE = [/THREE\.Clock/i]

export const test = base.extend<OfficeOptions & OfficeFixtures>({
  source: ['mock', { option: true }],
  allowConsoleErrors: [false, { option: true }],

  api: async ({ playwright }, use) => {
    const ctx = await playwright.request.newContext({ baseURL: API_URL })
    await use(ctx)
    await ctx.dispose()
  },

  context: async ({ context, source, api, allowConsoleErrors }, use, testInfo) => {
    // Demo teammates would move things while a test runs: switch them off before the app loads.
    await context.addInitScript(() => {
      try {
        localStorage.setItem('office-dashboard:demo', '0')
      } catch {
        /* storage blocked */
      }
    })
    if (source === 'api') {
      expect((await api.post('/api/reset', { data: {} })).ok()).toBe(true)
      expect((await api.put('/api/demo', { data: { on: false } })).ok()).toBe(true)
    }
    const errors: string[] = []
    watchConsole(context, errors)
    await use(context)
    if (!allowConsoleErrors && testInfo.status === testInfo.expectedStatus) {
      expect(errors, 'console errors during the test').toEqual([])
    }
  },
})

export { expect }

function watchConsole(context: BrowserContext, errors: string[]) {
  context.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    if (KNOWN_NOISE.some((re) => re.test(text))) return
    errors.push(`console.error: ${text} (${msg.location().url})`)
  })
  context.on('weberror', (e) => errors.push(`pageerror: ${e.error().message}`))
}

// ---- store access ---------------------------------------------------------------------------------------

/** The slice of the zustand state tests read. Kept loose on purpose: pickers run inside the page. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type StoreState = any

/** Run `pick(store.getState())` inside the page. `pick` must be self-contained (it is serialised). */
export function readStore<R>(page: Page, pick: (s: StoreState) => R): Promise<R> {
  return page.evaluate(async (src) => {
    const path = '/src/store.ts'
    const { useOffice } = await import(/* @vite-ignore */ path)
    return new Function('s', `return (${src})(s)`)(useOffice.getState())
  }, pick.toString())
}

/** Call a store action (e.g. 'createTask') inside the page and return its result. */
export function callStore<R = unknown>(page: Page, action: string, ...args: unknown[]): Promise<R> {
  return page.evaluate(
    async ([name, params]) => {
      const path = '/src/store.ts'
      const { useOffice } = await import(/* @vite-ignore */ path)
      return useOffice.getState()[name as string](...(params as unknown[]))
    },
    [action, args] as const,
  )
}

export function findTask(page: Page, title: string): Promise<Task | null> {
  return page.evaluate(async (t) => {
    const path = '/src/store.ts'
    const { useOffice } = await import(/* @vite-ignore */ path)
    return (Object.values(useOffice.getState().tasks) as Task[]).find((x) => x.title === t) ?? null
  }, title)
}

export async function taskByTitle(page: Page, title: string): Promise<Task> {
  const t = await findTask(page, title)
  if (!t) throw new Error(`no task titled "${title}"`)
  return t
}

/** Create a task through the store (works for both sources) and return it. */
export async function seedTask(page: Page, input: Record<string, unknown>): Promise<Task> {
  const task = await callStore<Task | null>(page, 'createTask', { projectId: 'p_web', ...input })
  if (!task) throw new Error('createTask failed')
  return task
}

/** Server-side truth (api source only). */
export async function serverWorkspace(api: APIRequestContext): Promise<Workspace> {
  const res = await api.get('/api/workspace')
  expect(res.ok()).toBe(true)
  return (await res.json()) as Workspace
}

export async function serverTask(api: APIRequestContext, id: string): Promise<Task | undefined> {
  return (await serverWorkspace(api)).tasks.find((t) => t.id === id)
}

// ---- opening the app ------------------------------------------------------------------------------------

export function appPath(source: Source): string {
  return source === 'api' ? '/?source=api' : '/'
}

/** Open the app and wait until data is loaded, the link is up (api) and the 3D scene is framed. */
export async function openApp(page: Page, source: Source, opts: { scene?: boolean } = {}): Promise<void> {
  await page.goto(appPath(source))
  await expect.poll(() => readStore(page, (s) => s.status), { message: 'store ready' }).toBe('ready')
  if (source === 'api') await expect.poll(() => readStore(page, (s) => s.connection), { message: 'api online' }).toBe('online')
  await expect(page.getByText('사무실을 여는 중…')).toBeHidden()
  if (opts.scene !== false) await waitForScene(page)
}

/** The canvas exists, every open task box registered, and the camera stopped easing. */
export async function waitForScene(page: Page): Promise<void> {
  await expect(page.locator('canvas')).toBeVisible()
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const rtPath = '/src/scene/runtime.ts'
          const storePath = '/src/store.ts'
          const rt = await import(/* @vite-ignore */ rtPath)
          const { useOffice } = await import(/* @vite-ignore */ storePath)
          const tasks = Object.keys(useOffice.getState().tasks).length
          return rt.sceneApi.get?.() != null && rt.boxLive.size >= tasks
        }),
      { message: 'scene mounted with all task boxes' },
    )
    .toBe(true)
  // Camera easing finished: the projection of a fixed floor point stops changing.
  let last = ''
  let same = 0
  await expect
    .poll(
      async () => {
        const p = await project(page, { kind: 'point', x: 13, y: 0, z: 9 })
        const key = p ? `${Math.round(p.x)},${Math.round(p.y)}` : ''
        same = key !== '' && key === last ? same + 1 : 0
        last = key
        return same
      },
      { message: 'camera settled', intervals: [150], timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(5)
}

// ---- 3D projection --------------------------------------------------------------------------------------

export type WorldSpec =
  | { kind: 'box'; id: string }
  | { kind: 'member'; id: string }
  | { kind: 'agenda' }
  | { kind: 'point'; x: number; y: number; z: number }

export interface ScreenPoint {
  x: number
  y: number
  /** The canvas itself (not a HUD panel) is under that pixel. */
  free: boolean
}

/** World position of a box / member / the meeting table, projected with the live camera to client pixels. */
export function project(page: Page, spec: WorldSpec): Promise<ScreenPoint | null> {
  return page.evaluate(async (s) => {
    const rtPath = '/src/scene/runtime.ts'
    const storePath = '/src/store.ts'
    const layoutPath = '/src/office/layout.ts'
    const pathsPath = '/src/scene/paths.ts'
    const furniturePath = '/src/scene/Furniture.tsx'
    const rt = await import(/* @vite-ignore */ rtPath)
    const { useOffice } = await import(/* @vite-ignore */ storePath)
    const api = rt.sceneApi.get?.()
    if (!api) return null
    let w: [number, number, number] | null = null
    if (s.kind === 'point') w = [s.x, s.y, s.z]
    else if (s.kind === 'box') {
      const b = rt.boxLive.get(s.id)
      const t = useOffice.getState().tasks[s.id]
      if (b && t) w = [b.x, b.y + (0.14 + t.estimate * 0.06) / 2, b.z]
    } else if (s.kind === 'member') {
      const live = rt.avatarLive.get(s.id)
      if (live?.visible) w = [live.x, 0.8, live.z]
      else {
        const { deskById } = await import(/* @vite-ignore */ layoutPath)
        const m = useOffice.getState().members[s.id]
        const d = m && deskById(m.deskId)
        if (d) w = [d.x, 0.8, d.z]
      }
    } else if (s.kind === 'agenda') {
      const { ROOMS } = await import(/* @vite-ignore */ pathsPath)
      const { TABLE_TOP_Y } = await import(/* @vite-ignore */ furniturePath)
      w = [ROOMS.meeting.cx, TABLE_TOP_Y, ROOMS.meeting.cz]
    }
    if (!w) return null
    const cam = api.camera
    cam.updateMatrixWorld()
    const V = cam.matrixWorldInverse.elements
    const P = cam.projectionMatrix.elements
    const [x, y, z] = w
    const vx = V[0] * x + V[4] * y + V[8] * z + V[12]
    const vy = V[1] * x + V[5] * y + V[9] * z + V[13]
    const vz = V[2] * x + V[6] * y + V[10] * z + V[14]
    const cx = P[0] * vx + P[4] * vy + P[8] * vz + P[12]
    const cy = P[1] * vx + P[5] * vy + P[9] * vz + P[13]
    const cw = P[3] * vx + P[7] * vy + P[11] * vz + P[15]
    if (cw <= 0) return null
    const rect = api.gl.domElement.getBoundingClientRect()
    const px = rect.left + ((cx / cw + 1) / 2) * rect.width
    const py = rect.top + ((1 - cy / cw) / 2) * rect.height
    return { x: px, y: py, free: document.elementFromPoint(px, py) === api.gl.domElement }
  }, spec)
}

/** Pixel offsets probed around a projected point (centre first, then growing rings, lower side first). */
const PROBE: [number, number][] = [[0, 0]]
for (const r of [3, 6, 9, 13, 18, 24]) {
  for (const [dx, dy] of [
    [0, 1],
    [1, 1],
    [-1, 1],
    [1, 0],
    [-1, 0],
    [0, -1],
    [1, -1],
    [-1, -1],
  ]) {
    PROBE.push([dx * r, dy * r])
  }
}

/** Wait for `n` animation frames (React effects and the R3F event system have run by then). */
export function frames(page: Page, n = 1): Promise<void> {
  return page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)))
        step(count)
      }),
    n,
  )
}

/** Wait until a projected target stops moving (a box that just flew somewhere, an avatar that is walking). */
export async function settled(page: Page, spec: WorldSpec): Promise<ScreenPoint> {
  let last = ''
  let same = 0
  let point: ScreenPoint | null = null
  await expect
    .poll(
      async () => {
        point = await project(page, spec)
        const key = point?.free ? `${Math.round(point.x)},${Math.round(point.y)}` : ''
        same = key !== '' && key === last ? same + 1 : 0
        last = key
        return same
      },
      { message: `${spec.kind} stands still on the canvas`, intervals: [120], timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(3)
  return point as unknown as ScreenPoint
}

/**
 * True once the canvas has been the topmost element under (x, y) for `need` consecutive frames.
 * App quirk this works around (reported): the hover label of a box is a DOM overlay that ignores its
 * pointer-events:none, so it appears over the box, steals the pointer (hover clears, label unmounts) and the
 * state only becomes stable a few frames later. Pressing before that would land on the label, not the box.
 */
async function canvasOnTop(page: Page, x: number, y: number, need = 8): Promise<boolean> {
  return page.evaluate(
    ([px, py, n]) =>
      new Promise<boolean>((resolve) => {
        let run = 0
        let total = 0
        const step = () => {
          run = document.elementFromPoint(px, py)?.tagName === 'CANVAS' ? run + 1 : 0
          if (run >= n) resolve(true)
          else if (++total > 90) resolve(false)
          else requestAnimationFrame(step)
        }
        step()
      }),
    [x, y, need] as const,
  )
}

/**
 * Move the real mouse onto a task box in the 3D view: the point is accepted when store.hover reports the box right
 * after the move and the pointer is then free of overlays, so the following press goes to the box.
 */
export async function hoverBox(page: Page, taskId: string): Promise<{ x: number; y: number }> {
  const base = await settled(page, { kind: 'box', id: taskId })
  for (const [dx, dy] of PROBE) {
    const x = base.x + dx
    const y = base.y + dy
    await page.mouse.move(x, y)
    const hover = await readStore(page, (s) => s.hover)
    if (hover?.kind !== 'task' || hover.id !== taskId) continue
    if (await canvasOnTop(page, x, y)) return { x, y }
  }
  throw new Error(`could not hover box ${taskId} near (${Math.round(base.x)}, ${Math.round(base.y)})`)
}

export type DropWant =
  | { kind: 'member'; id: string }
  | { kind: 'agenda' }
  | { kind: 'backlog' }
  | { kind: 'status'; status: string }
  | { kind: 'day'; date: string; memberId?: string | null }

/** Move the pressed mouse over a 3D target until the store's dropTarget is `want`. */
export async function moveToDropTarget(page: Page, spec: WorldSpec, want: DropWant): Promise<{ x: number; y: number }> {
  const base = await settled(page, spec)
  const wantJson = JSON.stringify(want)
  for (const [dx, dy] of PROBE) {
    const x = base.x + dx
    const y = base.y + dy
    await page.mouse.move(x, y, { steps: 6 })
    const got = await readStore(page, (s) => JSON.stringify(s.dropTarget))
    if (got === wantJson) return { x, y }
  }
  throw new Error(`no drop target ${wantJson} near (${Math.round(base.x)}, ${Math.round(base.y)})`)
}

/** Press a 3D task box, pick it up and hold it over `target` (mouse stays down). Returns after the drop target is set. */
export async function pickUpBoxOver(page: Page, taskId: string, spec: WorldSpec, want: DropWant): Promise<void> {
  const from = await hoverBox(page, taskId)
  await page.mouse.down()
  await page.mouse.move(from.x + 12, from.y + 12)
  await expect.poll(() => readStore(page, (s) => s.drag?.taskId ?? null), { message: 'drag started' }).toBe(taskId)
  await moveToDropTarget(page, spec, want)
}

/** Pick up a 3D task box and hold it over a DOM element (panel card, member row...) until the drop target is `want`. */
export async function pickUpBoxOverElement(page: Page, taskId: string, to: Locator, want: DropWant): Promise<void> {
  const from = await hoverBox(page, taskId)
  await page.mouse.down()
  await page.mouse.move(from.x + 12, from.y + 12)
  await expect.poll(() => readStore(page, (s) => s.drag?.taskId ?? null), { message: 'drag started' }).toBe(taskId)
  const b = await centerOf(to)
  await page.mouse.move(b.x, b.y, { steps: 12 })
  await expect.poll(() => readStore(page, (s) => JSON.stringify(s.dropTarget))).toBe(JSON.stringify(want))
}

/** Drag a 3D task box and release it over `target`. */
export async function dragBox(page: Page, taskId: string, spec: WorldSpec, want: DropWant): Promise<void> {
  await pickUpBoxOver(page, taskId, spec, want)
  await page.mouse.up()
  await expect.poll(() => readStore(page, (s) => s.drag), { message: 'drag ended' }).toBeNull()
}

// ---- panel (DOM) drags ----------------------------------------------------------------------------------

export async function centerOf(loc: Locator): Promise<{ x: number; y: number }> {
  await loc.scrollIntoViewIfNeeded()
  const box = await loc.boundingBox()
  if (!box) throw new Error('element has no box')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** Real-mouse drag from a panel card; releases over `to` (a locator) after `ready` says the drop target is set. */
export async function dragCard(page: Page, card: Locator, to: Locator, want?: DropWant): Promise<void> {
  const a = await centerOf(card)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(a.x + 8, a.y + 8)
  await expect.poll(() => readStore(page, (s) => s.drag !== null), { message: 'card drag started' }).toBe(true)
  const b = await centerOf(to)
  await page.mouse.move(b.x, b.y, { steps: 10 })
  if (want) await expect.poll(() => readStore(page, (s) => JSON.stringify(s.dropTarget))).toBe(JSON.stringify(want))
  await page.mouse.up()
  await expect.poll(() => readStore(page, (s) => s.drag), { message: 'drag ended' }).toBeNull()
}

// ---- common locators ------------------------------------------------------------------------------------

export const panel = (page: Page) => page.getByRole('region', { name: '관리 패널' })
export const tab = (page: Page, name: string) => page.getByRole('tab', { name: new RegExp(`^${name}`) })
export const taskCard = (page: Page, title: string) => panel(page).getByRole('button', { name: new RegExp(title) }).first()
