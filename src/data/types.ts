// Domain model. Shared contract between data/, scene/ and ui/. Owned by the architect.
// Shapes are API-friendly (plain JSON, ISO strings) so a backend can return them as-is.

export type Id = string

export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done'
export type Priority = 'low' | 'medium' | 'high' | 'urgent'
/** Story points. */
export type Estimate = 1 | 2 | 3 | 5 | 8

export interface Project {
  id: Id
  /** Short key shown on task labels, e.g. "WEB". */
  key: string
  name: string
  /** Hex color, used for task box labels and the project overlay. */
  color: string
}

export interface Task {
  id: Id
  /** Human-friendly number, unique per workspace, e.g. 42 → "WEB-42". */
  number: number
  title: string
  description: string
  status: TaskStatus
  priority: Priority
  estimate: Estimate
  projectId: Id
  /** null = unassigned → lives on the backlog shelf. */
  assigneeId: Id | null
  /** ISO date (YYYY-MM-DD) or null. */
  dueDate: string | null
  /** Sort key within a kanban column / desk stack (ascending). */
  order: number
  createdAt: string
  updatedAt: string
  /** ISO datetime when status became 'done', else null. */
  completedAt: string | null
  /** On the agenda for the next team meeting (sits on the meeting-room table). Open tasks only. */
  onAgenda: boolean
}

/** Where a member is right now. Drives where the avatar walks to. */
export type Presence = 'working' | 'meeting' | 'break' | 'away'

export interface Member {
  id: Id
  name: string
  /** e.g. "프론트엔드", "디자인". */
  role: string
  /** Hex color for the avatar's shirt and UI chips. */
  color: string
  /** Story points per week this person can comfortably take. */
  capacity: number
  /** Desk from OFFICE.desks. Unique among members. */
  deskId: string
  presence: Presence
  /** 0..n, picks hair style / accessory so avatars look distinct. */
  avatarVariant: number
  joinedAt: string
}

export type ActivityKind =
  | 'task_created'
  | 'task_updated'
  | 'task_assigned'
  | 'task_status'
  | 'task_deleted'
  | 'member_joined'
  | 'member_updated'
  | 'member_left'
  | 'presence'
  | 'meeting_started'
  | 'meeting_ended'
  /** Notices from the data source itself (e.g. storage recovered). */
  | 'system'

export interface Activity {
  id: Id
  at: string
  kind: ActivityKind
  /** Who did it: a member id, or null for the manager (the user). */
  actorId: Id | null
  taskId?: Id
  memberId?: Id
  /** Korean, one short sentence, ready to display. */
  message: string
}

// ---- Meetings (one meeting room → at most one ongoing meeting) -------------------

export type MeetingStatus = 'ongoing' | 'ended'

/** What the team decided for one agenda task when the meeting ended. */
export type AgendaOutcome =
  | { taskId: Id; action: 'assign'; memberId: Id }
  | { taskId: Id; action: 'status'; status: TaskStatus }
  | { taskId: Id; action: 'backlog' }
  /** Not settled — stays on the agenda for the next meeting. */
  | { taskId: Id; action: 'keep' }

export interface Meeting {
  id: Id
  title: string
  attendeeIds: Id[]
  /** Agenda tasks captured when the meeting started (tasks with onAgenda), in order. */
  agendaTaskIds: Id[]
  status: MeetingStatus
  startedAt: string
  endedAt: string | null
  /** Free-form minutes written at the end. */
  notes: string
  /** Decisions applied at the end (empty while ongoing). */
  outcomes: AgendaOutcome[]
}

export interface MeetingStart {
  title: string
  attendeeIds: Id[]
}

export interface MeetingEnd {
  notes: string
  /** At most one per agenda task; agenda tasks without an outcome count as 'keep'. */
  outcomes: AgendaOutcome[]
}

/** Everything the app needs at startup. */
export interface Workspace {
  projects: Project[]
  members: Member[]
  tasks: Task[]
  /** The ongoing meeting (if any) plus the most recent ended ones, newest last, at most 20. */
  meetings: Meeting[]
  /** Newest last, at most ~100. */
  activity: Activity[]
}

// ---- Inputs ----------------------------------------------------------------

export type TaskInput = Pick<Task, 'title' | 'projectId'> &
  Partial<Pick<Task, 'description' | 'status' | 'priority' | 'estimate' | 'assigneeId' | 'dueDate'>>

export type TaskPatch = Partial<
  Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'estimate' | 'projectId' | 'assigneeId' | 'dueDate' | 'order' | 'onAgenda'>
>

/** deskId is optional: the source picks a free desk when omitted. */
export type MemberInput = Pick<Member, 'name' | 'role' | 'color' | 'capacity'> & Partial<Pick<Member, 'deskId' | 'avatarVariant'>>

export type MemberPatch = Partial<Pick<Member, 'name' | 'role' | 'color' | 'capacity' | 'deskId' | 'presence'>>

/** What happens to a removed member's open tasks. */
export type Reassign = { mode: 'backlog' } | { mode: 'member'; memberId: Id }

/**
 * Pushed by a DataSource for every change, including ones caused by the app's own calls.
 * Upserts/deletes are idempotent so the store can apply them after an optimistic update.
 */
export type Change =
  | { type: 'task_upsert'; task: Task }
  | { type: 'task_delete'; id: Id }
  | { type: 'member_upsert'; member: Member }
  | { type: 'member_delete'; id: Id }
  | { type: 'project_upsert'; project: Project }
  | { type: 'meeting_upsert'; meeting: Meeting }
  | { type: 'activity'; activity: Activity }
  /** Replace everything (e.g. after a reset, or when a reconnect can't replay missed changes). */
  | { type: 'snapshot'; workspace: Workspace }
  /** Remote sources report their link state; local sources never emit this. */
  | { type: 'connection'; status: ConnectionStatus }
  /** Shared demo state changed (another client toggled it, server restarted, a toggle failed). */
  | { type: 'demo'; on: boolean }

export type ConnectionStatus = 'connecting' | 'online' | 'offline'
