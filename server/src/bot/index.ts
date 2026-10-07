// The demo bot: simulated teammates, written as a plain HTTP client of the public API. It never
// touches the database or server internals; every action is a fetch() with `X-Actor`, exactly what
// a real person's client would send. What to do next comes from src/data/rules/demo.ts (shared with the mock demo: weights, timings,
// meeting/break returns). `409 conflict` (the manager touched it) means "skip this one".
import { TOUCH_WINDOW_MS } from '../../../src/data/rules/constants.ts'
import { RETURN_SECONDS, demoTasksToPrune, planDemoAction } from '../../../src/data/rules/demo.ts'
import type { Id, Member, Presence, Workspace } from '../../../src/data/types.ts'

export interface BotOptions {
  baseUrl: string
  /** Real-time gap between actions (ms). */
  tickMs: [number, number]
  /** How long a 409'd task / member is left alone (the server's manager-touch window). */
  touchWindowMs?: number
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

  /** Tasks / members that answered 409 ("touched by the manager"): skipped until the touch window is over. */
  const blocked = new Map<string, number>()
  const isBlocked = (key: string) => {
    const until = blocked.get(key)
    if (until === undefined) return false
    if (Date.now() < until) return true
    blocked.delete(key)
    return false
  }
  async function guarded(key: string, p: Promise<Result>): Promise<Result> {
    const r = await p
    if (r.status === 409) blocked.set(key, Date.now() + (opts.touchWindowMs ?? TOUCH_WINDOW_MS))
    return r
  }
  const patchTask = (id: Id, patch: object, actor: Member, quiet = false) =>
    guarded(`task:${id}`, request('PATCH', `/api/tasks/${id}`, { body: patch, actor: actor.id, quiet }))
  const patchPresence = (m: Member, presence: Presence, quiet = true) =>
    guarded(`member:${m.id}`, request('PATCH', `/api/members/${m.id}`, { body: { presence }, actor: m.id, quiet }))

  // ---- planned returns --------------------------------------------------------------

  function plan(id: Id, presence: Presence, seconds: readonly [number, number]) {
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
    const inMeeting = attendeesOf(ws)
    for (const [id, p] of due) {
      const m = ws.members.find((x) => x.id === id)
      if (!m || m.presence !== p.presence || inMeeting.has(id)) {
        plans.delete(id)
        continue
      }
      const r = await patchPresence(m, 'working')
      if (r.status === 409 || r.status === 0) p.at = Date.now() + 5000 // the manager just set it: wait it out
      else plans.delete(id)
    }
  }

  /** Members sitting in an ongoing (manager-run) meeting: the bot must not touch their presence. */
  const attendeesOf = (ws: Workspace) => new Set(ws.meetings.filter((m) => m.status === 'ongoing').flatMap((m) => m.attendeeIds))

  /** Members away / in a meeting / on a break with no plan get one, so nobody stays stuck. */
  function reconcile(ws: Workspace, defaults: boolean) {
    const inMeeting = attendeesOf(ws)
    for (const [id, p] of [...plans]) {
      const m = ws.members.find((x) => x.id === id)
      if (!m || m.presence !== p.presence || inMeeting.has(id)) plans.delete(id)
    }
    for (const m of ws.members) {
      // Attendees of the manager's meeting come back when the manager ends it, never by the bot.
      if (m.presence === 'working' || plans.has(m.id) || inMeeting.has(m.id)) continue
      if (defaults) plan(m.id, m.presence, RETURN_SECONDS.adopt)
      else if (m.presence === 'meeting') plan(m.id, 'meeting', RETURN_SECONDS.meeting)
      else if (m.presence === 'break') plan(m.id, 'break', RETURN_SECONDS.break)
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

  /** Asks the shared demo rules what a teammate would do next, then does it over HTTP. */
  async function act(ws: Workspace) {
    const byId = new Map(ws.members.map((m) => [m.id, m]))
    const action = planDemoAction({
      ws,
      now: new Date(),
      random,
      incomingActor: true,
      isTaskFree: (t) => !isBlocked(`task:${t.id}`),
      isMemberFree: (m) => !isBlocked(`member:${m.id}`),
      informalMeetingPlanned: [...plans.values()].some((p) => p.presence === 'meeting'),
    })
    if (!action) return
    // A 409 (manager touched it, or an attendee of a real meeting) just means this tick does nothing.
    switch (action.name) {
      case 'start':
        await patchTask(action.taskId, { status: 'in_progress' }, byId.get(action.actorId)!, !action.feed)
        break
      case 'review':
        await patchTask(action.taskId, { status: 'review' }, byId.get(action.actorId)!, !action.feed)
        break
      case 'done':
        await patchTask(action.taskId, { status: 'done' }, byId.get(action.actorId)!)
        break
      case 'take':
        await patchTask(action.taskId, { assigneeId: action.actorId }, byId.get(action.actorId)!)
        break
      case 'incoming':
        await request('POST', '/api/tasks', { body: action.task, actor: action.actorId ?? undefined })
        break
      case 'meeting':
        // Only the first member leaves a feed row ("... 님이 회의에 들어갔어요").
        for (const [i, id] of action.memberIds.entries()) {
          const r = await patchPresence(byId.get(id)!, 'meeting', i > 0)
          if (r.status === 200) plan(id, 'meeting', RETURN_SECONDS.meeting)
        }
        break
      case 'break':
      case 'away': {
        const r = await patchPresence(byId.get(action.memberId)!, action.name)
        if (r.status === 200) plan(action.memberId, action.name, RETURN_SECONDS[action.name])
        break
      }
    }
  }

  /** Prunes only the bot's own done tasks, oldest first. Seed and manager tasks stay. */
  async function housekeeping(ws: Workspace) {
    const actor = ws.members[0]
    if (!actor) return
    for (const t of demoTasksToPrune(ws.tasks)) await request('DELETE', `/api/tasks/${t.id}`, { actor: actor.id, quiet: true })
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
