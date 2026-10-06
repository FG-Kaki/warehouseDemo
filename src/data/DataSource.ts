// The only door between the app and its data. Owned by the architect.
// Today: MockDataSource (seed + localStorage + demo mode). Later: ApiDataSource, GitHubDataSource…
import type { Change, Id, Member, MemberInput, MemberPatch, Reassign, Task, TaskInput, TaskPatch, Workspace } from './types'

export interface DataSource {
  /** Human-readable name for the UI, e.g. "로컬 데모 데이터". */
  readonly label: string

  load(): Promise<Workspace>

  createTask(input: TaskInput): Promise<Task>
  updateTask(id: Id, patch: TaskPatch): Promise<Task>
  deleteTask(id: Id): Promise<void>

  createMember(input: MemberInput): Promise<Member>
  updateMember(id: Id, patch: MemberPatch): Promise<Member>
  /** Moves the member's non-done tasks per `reassign`, then removes the member. */
  deleteMember(id: Id, reassign: Reassign): Promise<void>

  /**
   * Every change (own calls, demo mode, other users/server) is pushed here, plus one
   * `activity` change per meaningful action. Returns an unsubscribe function.
   */
  subscribe(listener: (change: Change) => void): () => void

  /** Optional: simulated teammates working on their own. Sources without it hide the toggle. */
  setDemoMode?(on: boolean): void
  /** Optional: wipe local data back to the seed. */
  reset?(): Promise<Workspace>
}

export type DataErrorCode = 'invalid' | 'not_found' | 'conflict' | 'unavailable'

/** Rejected promises from a DataSource carry this so the UI can show `message` (Korean). */
export class DataError extends Error {
  code: DataErrorCode
  constructor(message: string, code: DataErrorCode = 'invalid') {
    super(message)
    this.name = 'DataError'
    this.code = code
  }
}
