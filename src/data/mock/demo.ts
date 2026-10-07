// Demo mode: simulated teammates. Each tick performs at most ONE plausible action through the
// engine's normal mutation path, so changes, activities and persistence behave like real ones.
import { DEMO_TICK_MS, RETURN_SECONDS, demoTasksToPrune, planDemoAction, type DemoAction } from '../rules/demo'
import { demoIncomingMessage, informalMeetingMessage } from '../rules/messages'
import type { Id, Member, Task } from '../types'
import type { MockEngine } from './engine'
import type { Leader } from './leader'

export interface DemoOptions {
  random: () => number
  now: () => Date
  /** Only the leader tab runs demo actions and return timers. */
  leader: Leader
  /** Run real timers (default in the app). Tests turn this off and drive ticks themselves. */
  autoRun: boolean
}

export interface Demo {
  /** Idempotent and cheap: the store toggles this around dialogs and drags. */
  start(): void
  stop(): void
  readonly running: boolean
  /** One simulated action. Returns the action name, or null when nothing was feasible. */
  tick(): string | null
  /** Sends members who are in a meeting / on a break / away (with no timer) back to work soon. */
  adopt(): void
  /** What the independent return timer does when it fires (leader tab only). */
  returnTick(): void
  /** The leader lease changed hands: start or stop the real timers. */
  onLeaderChange(): void
}

/** How long a tab without a demo wish keeps the leader lease before handing it over. */
const STEP_DOWN_GRACE_MS = 15_000

export function createDemo(engine: MockEngine, { random, now, leader, autoRun }: DemoOptions): Demo {
  let timer: ReturnType<typeof setTimeout> | null = null
  let returnTimer: ReturnType<typeof setTimeout> | null = null
  let stepDownTimer: ReturnType<typeof setTimeout> | null = null
  /** The wish (store toggle). Only the leader tab acts on it; the others keep it for when they take over. */
  let wish = false

  engine.onReset(() => {
    if (returnTimer !== null) clearTimeout(returnTimer)
    returnTimer = null
    adopt(true)
  })
  // Another tab's data or planned returns arrived: honour them, never book fresh defaults.
  engine.onAdopt(() => {
    updateLeadership()
    syncRun()
  })

  const between = (min: number, max: number) => min + random() * (max - min)
  // (open agenda tasks are excluded by the shared planner itself)
  const taskFree = (t: Task) => !engine.touchedRecently('task', t.id)
  const memberFree = (m: Member) => !engine.touchedRecently('member', m.id)

  function unref(t: unknown) {
    if (typeof t === 'object' && t !== null && 'unref' in t && typeof t.unref === 'function') t.unref()
  }

  // ---- leadership --------------------------------------------------------------

  /** A tab wants to lead while demo is wished or someone still has to be sent back to work. */
  function updateLeadership() {
    if (wish || engine.getPlans().size > 0) {
      if (stepDownTimer !== null) clearTimeout(stepDownTimer)
      stepDownTimer = null
      leader.want(true)
      return
    }
    if (!autoRun || !leader.isLeader()) {
      if (stepDownTimer !== null) clearTimeout(stepDownTimer)
      stepDownTimer = null
      leader.want(false)
      return
    }
    // The store pauses demo briefly around dialogs and drags: don't hand over the lease for that.
    if (stepDownTimer === null) {
      stepDownTimer = setTimeout(() => {
        stepDownTimer = null
        if (!wish && engine.getPlans().size === 0) leader.want(false)
      }, STEP_DOWN_GRACE_MS)
      unref(stepDownTimer)
    }
  }

  /** Starts / stops the real timers to match: leader + wish → actions, leader + plans → returns. */
  function syncRun() {
    if (!autoRun) return
    const lead = leader.isLeader()
    if (wish && lead) {
      if (timer === null) schedule()
    } else if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (lead) armReturnTimer()
    else if (returnTimer !== null) {
      clearTimeout(returnTimer)
      returnTimer = null
    }
  }

  // ---- presence bookkeeping --------------------------------------------------

  /** One timer for the earliest planned return; runs whether or not demo mode is on (leader tab only). */
  function armReturnTimer() {
    if (!autoRun) return
    if (returnTimer !== null) clearTimeout(returnTimer)
    returnTimer = null
    const plans = engine.getPlans()
    if (plans.size === 0 || !leader.isLeader()) return
    const next = Math.min(...[...plans.values()].map((r) => r.at))
    const delay = Math.min(60_000, Math.max(1000, next - now().getTime()))
    returnTimer = setTimeout(() => {
      returnTimer = null
      try {
        processReturns(false)
      } catch (e) {
        console.error('demo mode: return failed', e)
      }
      updateLeadership()
      armReturnTimer()
    }, delay)
    unref(returnTimer)
  }

  function scheduleReturn(id: Id, presence: Member['presence'], seconds: [number, number]) {
    engine.setPlan(id, { at: now().getTime() + between(seconds[0], seconds[1]) * 1000, presence })
    updateLeadership()
    armReturnTimer()
  }

  /** Attendees of a meeting the manager started belong to it until the manager ends it. */
  function inMeeting(): Set<Id> {
    const meeting = engine.ws.meetings.find((m) => m.status === 'ongoing')
    return new Set(meeting ? meeting.attendeeIds : [])
  }

  function processReturns(adoptManagerSet: boolean) {
    const ws = engine.ws
    const t = now().getTime()
    const busy = inMeeting()
    if (adoptManagerSet) {
      // Members in a meeting / on a break without a plan (seed, manager) get one, unless the manager just set them.
      for (const m of ws.members) {
        if (busy.has(m.id) || engine.getPlans().has(m.id) || !memberFree(m)) continue
        if (m.presence === 'meeting') scheduleReturn(m.id, 'meeting', RETURN_SECONDS.meeting)
        else if (m.presence === 'break') scheduleReturn(m.id, 'break', RETURN_SECONDS.break)
      }
    }
    const due: Id[] = []
    for (const [id, r] of [...engine.getPlans()]) {
      const m = ws.members.find((x) => x.id === id)
      if (m && busy.has(id)) {
        engine.setPlan(id, null)
        continue
      }
      if (!m || m.presence !== r.presence) {
        engine.setPlan(id, null)
        continue
      }
      if (r.at > t) continue
      if (!memberFree(m)) continue // the manager set this presence a moment ago: wait it out
      due.push(id)
      engine.setPlan(id, null)
    }
    if (due.length > 0) engine.setPresence(due, 'working', null)
  }

  /**
   * After load / reset: members who are away, in a meeting or on a break with no planned return get a
   * short default one, so nobody stays stuck even with demo off. Existing plans (any tab) are honoured.
   */
  function adopt(bookDefaults = true) {
    if (bookDefaults) {
      const busy = inMeeting()
      for (const m of engine.ws.members) {
        if (m.presence === 'working' || busy.has(m.id) || engine.getPlans().has(m.id) || !memberFree(m)) continue
        scheduleReturn(m.id, m.presence, RETURN_SECONDS.adopt)
      }
    }
    updateLeadership()
    syncRun()
  }

  // ---- housekeeping ----------------------------------------------------------

  /** Prunes only demo-created ('td_' ids) done tasks, oldest first. Seed and manager tasks stay. */
  function housekeeping() {
    for (const t of demoTasksToPrune(engine.ws.tasks)) engine.deleteTask(t.id, { silent: true, demo: true })
  }

  // ---- actions ---------------------------------------------------------------

  function tick(): string | null {
    if (!leader.isLeader()) return null
    processReturns(true)
    const name = act()
    housekeeping()
    return name
  }

  /** Asks the shared planner what a teammate would do now, then performs it through the engine. */
  function act(): string | null {
    const action = planDemoAction({
      ws: engine.ws,
      now: now(),
      random,
      nextNumber: engine.nextNumber,
      isTaskFree: taskFree,
      isMemberFree: memberFree,
      informalMeetingPlanned: [...engine.getPlans().values()].some((r) => r.presence === 'meeting'),
    })
    if (!action) return null
    perform(action)
    return action.name
  }

  function perform(action: DemoAction) {
    switch (action.name) {
      case 'start':
        engine.updateTask(action.taskId, { status: 'in_progress' }, { demo: true, actorId: action.actorId, message: action.feed ? undefined : null })
        break
      case 'review':
        engine.updateTask(action.taskId, { status: 'review' }, { demo: true, actorId: action.actorId, message: action.feed ? undefined : null })
        break
      case 'done':
        engine.updateTask(action.taskId, { status: 'done' }, { demo: true, actorId: action.actorId })
        break
      case 'take':
        engine.updateTask(action.taskId, { assigneeId: action.actorId }, { demo: true, actorId: action.actorId })
        break
      case 'incoming':
        engine.createTask(action.task, { demo: true, actorId: null, message: demoIncomingMessage(action.ref), kind: 'task_created' })
        break
      case 'meeting':
        for (const id of action.memberIds) scheduleReturn(id, 'meeting', RETURN_SECONDS.meeting)
        engine.setPresence(action.memberIds, 'meeting', { message: informalMeetingMessage(action.title), memberId: action.memberIds[0] })
        break
      case 'break':
        scheduleReturn(action.memberId, 'break', RETURN_SECONDS.break)
        engine.setPresence([action.memberId], 'break')
        break
      case 'away':
        scheduleReturn(action.memberId, 'away', RETURN_SECONDS.away)
        engine.setPresence([action.memberId], 'away')
        break
    }
  }

  // ---- timer -----------------------------------------------------------------

  function schedule() {
    timer = setTimeout(() => {
      timer = null
      if (!wish || !leader.isLeader()) return
      try {
        tick()
      } catch (e) {
        console.error('demo mode: tick failed', e)
      }
      syncRun()
    }, between(DEMO_TICK_MS[0], DEMO_TICK_MS[1]))
  }

  return {
    start() {
      if (wish) return
      wish = true
      updateLeadership()
      syncRun()
    },
    stop() {
      if (!wish) return
      wish = false
      updateLeadership()
      syncRun()
      // Return timers keep running (on the leader): nobody stays stuck in a meeting because demo was switched off.
    },
    get running() {
      return wish
    },
    tick,
    adopt: () => adopt(true),
    onLeaderChange() {
      syncRun()
    },
    returnTick: () => {
      if (!leader.isLeader()) return
      processReturns(false)
      updateLeadership()
      armReturnTimer()
    },
  }
}
