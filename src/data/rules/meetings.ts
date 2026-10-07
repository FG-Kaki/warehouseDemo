// Pure meeting rules (docs/API.md, "Meetings" + "Clarifications"), shared by the mock source and the
// server. The plan functions take validated input and a snapshot, and return the entity changes the
// caller must apply (and emit), plus the activity text. Nothing here writes anything.
import { PRIORITY_META } from '../meta'
import type { AgendaOutcome, Id, Meeting, Member, Task } from '../types'
import { meetingEndedMessage, meetingStartedMessage } from './messages'
import { sendToBacklog, topOrder } from './tasks'

/** The ongoing meeting plus this many of the most recent ended ones are kept / returned. */
export const MAX_ENDED_MEETINGS = 20

export const ongoingMeeting = (meetings: readonly Meeting[]): Meeting | undefined => meetings.find((m) => m.status === 'ongoing')

/** The ongoing meeting + the most recent ended ones, in the order given (newest last). */
export function recentMeetings(meetings: readonly Meeting[]): Meeting[] {
  const keepEnded = new Set(meetings.filter((m) => m.status === 'ended').slice(-MAX_ENDED_MEETINGS))
  return meetings.filter((m) => m.status === 'ongoing' || keepEnded.has(m))
}

/** Open agenda tasks in meeting order: priority weight desc, then number. */
export function agendaOrder(tasks: readonly Task[]): Task[] {
  const weight = (t: Task) => PRIORITY_META[t.priority].weight
  return tasks.filter((t) => t.onAgenda && t.status !== 'done').sort((a, b) => weight(b) - weight(a) || a.number - b.number)
}

/** The ongoing meeting minus a removed attendee, or null when nothing changes. */
export function dropAttendee(meeting: Meeting | undefined, memberId: Id): Meeting | null {
  if (!meeting || meeting.status !== 'ongoing' || !meeting.attendeeIds.includes(memberId)) return null
  return { ...meeting, attendeeIds: meeting.attendeeIds.filter((x) => x !== memberId) }
}

/** The ongoing meeting minus a deleted agenda task, or null when nothing changes. */
export function dropAgendaTask(meeting: Meeting | undefined, taskId: Id): Meeting | null {
  if (!meeting || meeting.status !== 'ongoing' || !meeting.agendaTaskIds.includes(taskId)) return null
  return { ...meeting, agendaTaskIds: meeting.agendaTaskIds.filter((x) => x !== taskId) }
}

export interface MeetingStartPlan {
  meeting: Meeting
  /** One copy per attendee (every attendee, even one already in a meeting), presence 'meeting'. */
  members: Member[]
  message: string
}

export function planMeetingStart(input: {
  id: Id
  title: string
  attendeeIds: readonly Id[]
  tasks: readonly Task[]
  members: readonly Member[]
  at: string
  actorName?: string | null
}): MeetingStartPlan {
  const agenda = agendaOrder(input.tasks)
  const members: Member[] = []
  for (const id of input.attendeeIds) {
    const m = input.members.find((x) => x.id === id)
    if (m) members.push({ ...m, presence: 'meeting' })
  }
  const meeting: Meeting = {
    id: input.id,
    title: input.title,
    attendeeIds: [...input.attendeeIds],
    agendaTaskIds: agenda.map((t) => t.id),
    status: 'ongoing',
    startedAt: input.at,
    endedAt: null,
    notes: '',
    outcomes: [],
  }
  return { meeting, members, message: meetingStartedMessage(input.title, meeting.attendeeIds.length, meeting.agendaTaskIds.length, input.actorName) }
}

export interface MeetingEndPlan {
  /** The ended meeting (outcomes = the ones that were applied: tasks deleted meanwhile are dropped). */
  meeting: Meeting
  /** Only tasks that actually changed, as new copies, in agenda order. */
  tasks: Task[]
  /** Attendees whose presence went from 'meeting' back to 'working'. */
  members: Member[]
  /** Outcomes other than 'keep' (the "결정 K건" count). */
  decisions: number
  message: string
}

/**
 * Applies the outcomes to the tasks as they are now (including one completed during the meeting: a
 * `status` outcome may reopen it). 'keep' and "no outcome" leave a task on the agenda; every other
 * outcome clears it. An outcome that changes nothing writes nothing. `assign` re-tops the order only
 * when the assignee changes. Only attendees still in 'meeting' go back to 'working'.
 */
export function planMeetingEnd(input: {
  meeting: Meeting
  notes: string
  outcomes: readonly AgendaOutcome[]
  tasks: readonly Task[]
  members: readonly Member[]
  at: string
  actorName?: string | null
}): MeetingEndPlan {
  const { meeting, at } = input
  const working = input.tasks.map((t) => ({ ...t }))
  const byId = new Map(working.map((t) => [t.id, t]))
  const ctx = { topOrder: (assigneeId: Id | null) => topOrder(working, assigneeId) }
  const applied = input.outcomes.filter((o) => byId.has(o.taskId))
  const decided = new Map(applied.map((o) => [o.taskId, o]))

  const changedTasks: Task[] = []
  for (const taskId of meeting.agendaTaskIds) {
    const task = byId.get(taskId)
    if (!task) continue // deleted meanwhile
    const o: AgendaOutcome = decided.get(taskId) ?? { taskId, action: 'keep' }
    const before = JSON.stringify(task)
    if (o.action === 'assign') {
      if (task.assigneeId !== o.memberId) {
        task.assigneeId = o.memberId
        task.order = ctx.topOrder(o.memberId)
      }
    } else if (o.action === 'status') {
      if (task.status !== o.status) {
        task.status = o.status
        task.completedAt = o.status === 'done' ? at : null
      }
    } else if (o.action === 'backlog') {
      sendToBacklog(task, ctx)
    }
    if (o.action !== 'keep') task.onAgenda = false
    if (JSON.stringify(task) === before) continue
    task.updatedAt = at
    changedTasks.push(task)
  }

  const members: Member[] = []
  for (const id of meeting.attendeeIds) {
    const m = input.members.find((x) => x.id === id)
    if (m && m.presence === 'meeting') members.push({ ...m, presence: 'working' })
  }

  const decisions = applied.filter((o) => o.action !== 'keep').length
  return {
    meeting: { ...meeting, status: 'ended', endedAt: at, notes: input.notes, outcomes: applied.map((o) => ({ ...o })) },
    tasks: changedTasks,
    members,
    decisions,
    message: meetingEndedMessage(meeting.title, decisions, input.actorName),
  }
}
