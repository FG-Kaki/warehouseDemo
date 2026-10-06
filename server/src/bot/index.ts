// The demo bot: simulated teammates, written as a plain HTTP client of the public API. It never
// touches the database or server internals; every action is a fetch() with `X-Actor`, exactly what
// a real person's client would send. Behaviour mirrors src/data/mock/demo.ts (weights, timings,
// meeting/break returns). `409 conflict` (the manager touched it) means "skip this one".
import { PRIORITY_META } from '../../../src/data/meta.ts'
import { backlogTasks, todayIso, workload } from '../../../src/data/selectors.ts'
import type { Estimate, Id, Member, Presence, Task, Workspace } from '../../../src/data/types.ts'
import { POOL } from './pool.ts'

export interface BotOptions {
  baseUrl: string
  /** Real-time gap between actions (ms). */
  tickMs: [number, number]
  random?: () => number
  log?: (message: string) => void
}

export interface Bot {
  readonly running: boolean
  start(): void
  /** Stops new actions. Planned returns from meetings/breaks still finish, so nobody stays stuck. */
  stop(): void
  /** Stops everything, including pending returns. */
  dispose(): void
}

const MAX_BOT_DONE = 40
const MAX_BACKLOG = 10
/** Chance that a routine move (start / to review) leaves a feed row. */
const ROUTINE_FEED_CHANCE = 0.35
/** Server-assigned id prefix of tasks created by actor requests (see repo.ts). */
const BOT_TASK_PREFIX = 'td_'

interface Plan {
  at: number
  presence: Presence
}

interface Result {
  /** HTTP status, 0 when the server could not be reached. */
  status: number
}

export function createBot(opts: BotOptions): Bot {
  const random = opts.random ?? Math.random
  const log = opts.log ?? (() => {})
  let running = false
  let disposed = false
  /** Bumped by every start() / stop(): a tick loop belonging to an older generation never re-arms. */
  let generation = 0
  let tickTimer: ReturnType<typeof setTimeout> | null = null
  let returnTimer: ReturnType<typeof setTimeout> | null = null
  /** Planned returns to work, by member id. In memory only: a restart just forgets them. */
  const plans = new Map<Id, Plan>()
  let chain: Promise<void> = Promise.resolve()

  const pick = <T>(list: T[]): T => list[Math.min(list.length - 1, Math.floor(random() * list.length))]
  const between = (min: number, max: number) => min + random() * (max - min)

  /** Runs one thing at a time, so ticks and returns never interleave their requests. */
  function serial(fn: () => Promise<void>): Promise<void> {
    chain = chain.then(async () => {
      if (disposed) return
      try {
        await fn()
      } catch (e) {
        log(`demo bot: ${e instanceof Error ? e.message : String(e)}`)
      }
    })
    return chain
  }

  // ---- HTTP -----------------------------------------------------------------------

  async function request(method: string, path: string, init: { body?: unknown; actor?: Id; quiet?: boolean } = {}): Promise<Result & { body: unknown }> {
    const headers: Record<string, string> = {}
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'
    if (init.actor) headers['X-Actor'] = init.actor
    if (init.quiet) headers['X-Quiet'] = '1'
    try {
      const res = await fetch(opts.baseUrl + path, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) })
      const text = await res.text()
      return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null }
    } catch {
      return { status: 0, body: null }
    }
  }

  async function getWorkspace(): Promise<Workspace | null> {
    const r = await request('GET', '/api/workspace')
    return r.status === 200 ? (r.body as Workspace) : null
  }

  const patchTask = (id: Id, patch: object, actor: Member, quiet = false) => request('PATCH', `/api/tasks/${id}`, { body: patch, actor: actor.id, quiet })
  const patchPresence = (m: Member, presence: Presence, quiet = true) => request('PATCH', `/api/members/${m.id}`, { body: { presence }, actor: m.id, quiet })

  // ---- planned returns --------------------------------------------------------------

  function plan(id: Id, presence: Presence, seconds: [number, number]) {
    plans.set(id, { at: Date.now() + between(seconds[0], seconds[1]) * 1000, presence })
    armReturns()
  }

  /** One timer for the earliest planned return; runs whether or not the bot is acting. */
  function armReturns() {
    if (returnTimer !== null) clearTimeout(returnTimer)
    returnTimer = null
    if (disposed || plans.size === 0) return
    const next = Math.min(...[...plans.values()].map((p) => p.at))
    const delay = Math.min(30_000, Math.max(1000, next - Date.now()))
    returnTimer = setTimeout(() => {
      returnTimer = null
      void serial(processReturns).then(armReturns)
    }, delay)
    returnTimer.unref()
  }

  async function processReturns() {
    const t = Date.now()
    const due = [...plans].filter(([, p]) => p.at <= t)
    if (due.length === 0) return
    const ws = await getWorkspace()
    if (!ws) return // server unreachable: try again on the next timer
    for (const [id, p] of due) {
      const m = ws.members.find((x) => x.id === id)
      if (!m || m.presence !== p.presence) {
        plans.delete(id)
        continue
      }
      const r = await patchPresence(m, 'working')
      if (r.status === 409 || r.status === 0) p.at = Date.now() + 5000 // the manager just set it: wait it out
      else plans.delete(id)
    }
  }

  /** Members away / in a meeting / on a break with no plan get one, so nobody stays stuck. */
  function reconcile(ws: Workspace, defaults: boolean) {
    for (const [id, p] of [...plans]) {
      const m = ws.members.find((x) => x.id === id)
      if (!m || m.presence !== p.presence) plans.delete(id)
    }
    for (const m of ws.members) {
      if (m.presence === 'working' || plans.has(m.id)) continue
      if (defaults) plan(m.id, m.presence, [8, 15])
      else if (m.presence === 'meeting') plan(m.id, 'meeting', [20, 40])
      else if (m.presence === 'break') plan(m.id, 'break', [15, 30])
    }
  }

  // ---- one action per tick ------------------------------------------------------------

  async function tick() {
    const ws = await getWorkspace()
    if (!ws) return
    reconcile(ws, false)
    await act(ws)
    await housekeeping(ws)
  }

  interface Candidate {
    name: string
    weight: number
    run: () => Promise<Result | void>
  }

  async function act(ws: Workspace) {
    const members = ws.members
    const working = members.filter((m) => m.presence === 'working')
    const byId = new Map(members.map((m) => [m.id, m]))
    const routineQuiet = () => random() >= ROUTINE_FEED_CHANCE
    const candidates: Candidate[] = []
    const weightOf = (t: Task) => PRIORITY_META[t.priority].weight

    // todo -> in_progress: a working member with nothing in progress starts their best todo.
    const starters = working
      .filter((m) => !ws.tasks.some((t) => t.assigneeId === m.id && t.status === 'in_progress'))
      .map((m) => ({
        m,
        task: ws.tasks
          .filter((t) => t.assigneeId === m.id && t.status === 'todo')
          .sort((a, b) => weightOf(b) - weightOf(a) || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.order - b.order)[0],
      }))
      .filter((x) => x.task)
    if (starters.length > 0) {
      candidates.push({
        name: 'start',
        weight: 22,
        run: () => {
          const { m, task } = pick(starters)
          return patchTask(task.id, { status: 'in_progress' }, m, routineQuiet())
        },
      })
    }

    // in_progress -> review
    const inProgress = ws.tasks.filter((t) => t.status === 'in_progress' && working.some((m) => m.id === t.assigneeId))
    if (inProgress.length > 0) {
      candidates.push({
        name: 'review',
        weight: 16,
        run: () => {
          const task = pick(inProgress)
          return patchTask(task.id, { status: 'review' }, byId.get(task.assigneeId!)!, routineQuiet())
        },
      })
    }

    // review -> done: someone (preferably another member) finishes the review.
    const inReview = ws.tasks.filter((t) => t.status === 'review')
    if (inReview.length > 0 && working.length > 0) {
      candidates.push({
        name: 'done',
        weight: 18,
        run: () => {
          const task = pick(inReview)
          const others = working.filter((m) => m.id !== task.assigneeId)
          const actor = others.length > 0 ? pick(others) : working.find((m) => m.id === task.assigneeId) ?? working[0]
          return patchTask(task.id, { status: 'done' }, actor)
        },
      })
    }

    // backlog -> a light member takes the most important unassigned task.
    const record: Record<Id, Task> = Object.fromEntries(ws.tasks.map((t) => [t.id, t]))
    const backlog = backlogTasks(record)
    const light = working.map((m) => ({ m, w: workload(m, record) })).filter((x) => x.w < 0.8)
    if (backlog.length > 0 && light.length > 0) {
      candidates.push({
        name: 'take',
        weight: 14,
        run: () => {
          const lowest = Math.min(...light.map((x) => x.w))
          const { m } = pick(light.filter((x) => x.w === lowest))
          return patchTask(backlog[0].id, { assigneeId: m.id }, m)
        },
      })
    }

    // new incoming work, mostly when the backlog runs dry.
    const newWeight = backlog.length < 4 ? 26 : backlog.length < MAX_BACKLOG ? 5 : 0
    if (newWeight > 0 && members.length > 0) candidates.push({ name: 'incoming', weight: newWeight, run: () => createIncoming(ws, working.length > 0 ? pick(working) : pick(members)) })

    // presence
    const room = Math.floor(members.length / 2) - (members.length - working.length)
    const meetingRunning = [...plans.values()].some((p) => p.presence === 'meeting')
    if (!meetingRunning && room >= 2 &&working.length >= 3) {
      candidates.push({
        name: 'meeting',
        weight: 3,
        run: async () => {
          const k = Math.min(room, 2 + Math.floor(random() * 2))
          const pool = [...working]
          const group: Member[] = []
          while (group.length < k && pool.length > 0) group.push(pool.splice(Math.floor(random() * pool.length), 1)[0])
          // Only the first member leaves a feed row ("... 님이 회의에 들어갔어요").
          for (const [i, m] of group.entries()) {
            const r = await patchPresence(m, 'meeting', i > 0)
            if (r.status === 200) plan(m.id, 'meeting', [20, 40])
          }
        },
      })
    }
    if (room >= 1 && working.length > 0) {
      candidates.push({
        name: 'break',
        weight: 5,
        run: async () => {
          const m = pick(working)
          const r = await patchPresence(m, 'break')
          if (r.status === 200) plan(m.id, 'break', [15, 30])
          return r
        },
      })
      candidates.push({
        name: 'away',
        weight: 1,
        run: async () => {
          const m = pick(working)
          const r = await patchPresence(m, 'away')
          if (r.status === 200) plan(m.id, 'away', [40, 70])
          return r
        },
      })
    }

    const total = candidates.reduce((s, c) => s + c.weight, 0)
    if (total <= 0) return
    let r = random() * total
    let chosen = candidates[candidates.length - 1]
    for (const c of candidates) {
      r -= c.weight
      if (r < 0) {
        chosen = c
        break
      }
    }
    await chosen.run() // a 409 (manager touched it) just means this tick does nothing
  }

  async function createIncoming(ws: Workspace, actor: Member) {
    const item = pick(POOL)
    const project = ws.projects.find((p) => p.key === item.p) ?? ws.projects[0]
    if (!project) return
    // Re-use the pool with a numbered suffix once a title already exists.
    const same = ws.tasks.filter((t) => t.title === item.title || t.title.startsWith(`${item.title} `)).length
    const title = same > 0 ? `${item.title} ${same + 1}차` : item.title
    let dueDate: string | null = null
    if (random() > 0.3) {
      const d = new Date()
      d.setDate(d.getDate() + 3 + Math.floor(random() * 12))
      dueDate = todayIso(d)
    }
    const estimate: Estimate = item.est
    return request('POST', '/api/tasks', {
      body: { title, projectId: project.id, description: item.desc, priority: item.pri, estimate, dueDate },
      actor: actor.id,
    })
  }

  /** Prunes only the bot's own done tasks, oldest first. Seed and manager tasks stay. */
  async function housekeeping(ws: Workspace) {
    const done = ws.tasks.filter((t) => t.status === 'done' && t.id.startsWith(BOT_TASK_PREFIX))
    if (done.length <= MAX_BOT_DONE) return
    const actor = ws.members[0]
    if (!actor) return
    done.sort((a, b) => (a.completedAt ?? '').localeCompare(b.completedAt ?? ''))
    for (const t of done.slice(0, done.length - MAX_BOT_DONE)) {
      await request('DELETE', `/api/tasks/${t.id}`, { actor: actor.id, quiet: true })
    }
  }

  // ---- timer ------------------------------------------------------------------------

  function schedule(gen: number) {
    if (disposed || !running || gen !== generation) return
    tickTimer = setTimeout(() => {
      tickTimer = null
      if (!running || gen !== generation) return
      void serial(tick).then(() => schedule(gen))
    }, between(opts.tickMs[0], opts.tickMs[1]))
    tickTimer.unref()
  }

  return {
    get running() {
      return running
    },
    start() {
      if (running || disposed) return
      running = true
      generation++
      // Like the mock on load: whoever is away / in a meeting / on a break gets a short planned return.
      void serial(async () => {
        const ws = await getWorkspace()
        if (ws) reconcile(ws, true)
      })
      schedule(generation)
    },
    stop() {
      running = false
      generation++
      if (tickTimer !== null) clearTimeout(tickTimer)
      tickTimer = null
    },
    dispose() {
      disposed = true
      running = false
      generation++
      if (tickTimer !== null) clearTimeout(tickTimer)
      if (returnTimer !== null) clearTimeout(returnTimer)
      tickTimer = returnTimer = null
      plans.clear()
    },
  }
}
