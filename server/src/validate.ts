// Field validation. Rules and Korean messages are the same as the mock source (src/data/mock/engine.ts).
import { DataError } from '../../src/data/DataSource.ts'
import { ESTIMATES, PRESENCE_META, PRIORITY_META, STATUSES } from '../../src/data/meta.ts'
import { deskById } from '../../src/office/layout.ts'
import type { AgendaOutcome, Id, Presence, Task } from '../../src/data/types.ts'

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** What validation needs to know about the current data. */
export interface Lookup {
  hasProject(id: Id): boolean
  hasMember(id: Id): boolean
  hasTask(id: Id): boolean
  /** Member id sitting at the desk, if any. */
  deskOwner(deskId: string): Id | undefined
}

export function checkTitle(v: unknown): string {
  const title = typeof v === 'string' ? v.trim() : ''
  if (title.length === 0) throw new DataError('제목을 입력해 주세요')
  if (title.length > 120) throw new DataError('제목은 120자 이하로 입력해 주세요')
  return title
}

export function checkDescription(v: unknown): string {
  if (typeof v !== 'string') throw new DataError('설명이 올바르지 않아요')
  if (v.length > 2000) throw new DataError('설명은 2000자 이하로 입력해 주세요')
  return v
}

export function checkStatus(v: unknown): Task['status'] {
  if (!STATUSES.includes(v as Task['status'])) throw new DataError('올바르지 않은 상태예요')
  return v as Task['status']
}

export function checkPriority(v: unknown): Task['priority'] {
  if (typeof v !== 'string' || !Object.hasOwn(PRIORITY_META, v)) throw new DataError('올바르지 않은 우선순위예요')
  return v as Task['priority']
}

export function checkEstimate(v: unknown): Task['estimate'] {
  if (!ESTIMATES.includes(v as Task['estimate'])) throw new DataError('예상 포인트가 올바르지 않아요')
  return v as Task['estimate']
}

export function checkDueDate(v: unknown): string | null {
  if (v === null) return null
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = new Date(`${v}T00:00:00Z`)
    if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v) return v
  }
  throw new DataError('마감일 형식이 올바르지 않아요')
}

export function checkProject(v: unknown, l: Lookup): Id {
  if (typeof v !== 'string' || !l.hasProject(v)) throw new DataError('프로젝트를 찾을 수 없어요')
  return v
}

export function checkAssignee(v: unknown, l: Lookup): Id | null {
  if (v === null) return null
  if (typeof v !== 'string' || !l.hasMember(v)) throw new DataError('팀원을 찾을 수 없어요')
  return v
}

export function checkOrder(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new DataError('순서가 올바르지 않아요')
  return v
}

export function checkName(v: unknown): string {
  const name = typeof v === 'string' ? v.trim() : ''
  if (name.length === 0) throw new DataError('이름을 입력해 주세요')
  if (name.length > 30) throw new DataError('이름은 30자 이하로 입력해 주세요')
  return name
}

export function checkRole(v: unknown): string {
  const role = typeof v === 'string' ? v.trim() : ''
  if (role.length > 30) throw new DataError('역할은 30자 이하로 입력해 주세요')
  return role || '팀원'
}

export function checkColor(v: unknown): string {
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) throw new DataError('색상이 올바르지 않아요')
  return v
}

export function checkCapacity(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 40) throw new DataError('주간 여유량은 1~40 사이로 입력해 주세요')
  return v
}

export function checkPresence(v: unknown): Presence {
  if (typeof v !== 'string' || !Object.hasOwn(PRESENCE_META, v)) throw new DataError('올바르지 않은 상태예요')
  return v as Presence
}

export function checkVariant(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new DataError('아바타 모양이 올바르지 않아요')
  return v
}

export function checkDesk(deskId: unknown, l: Lookup, selfId?: Id): string {
  if (typeof deskId !== 'string' || !deskById(deskId)) throw new DataError('존재하지 않는 자리예요')
  const owner = l.deskOwner(deskId)
  if (owner !== undefined && owner !== selfId) throw new DataError('이미 사용 중인 자리예요', 'conflict')
  return deskId
}

// ---- meetings ---------------------------------------------------------------------

export function checkAgendaFlag(v: unknown): boolean {
  if (typeof v !== 'boolean') throw new DataError('안건 값이 올바르지 않아요')
  return v
}

export function checkMeetingTitle(v: unknown): string {
  const title = typeof v === 'string' ? v.trim() : ''
  if (title.length === 0) throw new DataError('회의 이름을 입력해 주세요')
  if (title.length > 60) throw new DataError('회의 이름은 60자 이하로 입력해 주세요')
  return title
}

/** Attendees: at least one, unique, all existing members. */
export function checkAttendees(v: unknown, l: Lookup): Id[] {
  if (!Array.isArray(v) || v.length === 0) throw new DataError('참석자를 한 명 이상 골라 주세요')
  const ids: Id[] = []
  for (const id of v) {
    if (typeof id !== 'string' || !l.hasMember(id)) throw new DataError('팀원을 찾을 수 없어요')
    if (ids.includes(id)) throw new DataError('같은 참석자가 여러 번 들어 있어요')
    ids.push(id)
  }
  return ids
}

export function checkNotes(v: unknown): string {
  if (v === undefined) return ''
  if (typeof v !== 'string') throw new DataError('회의록이 올바르지 않아요')
  if (v.length > 2000) throw new DataError('회의록은 2000자 이하로 입력해 주세요')
  return v
}

/** Outcomes of an ending meeting: on the agenda, at most one per task, well-formed. Returns clean copies. */
export function checkOutcomes(v: unknown, agenda: Id[], l: Lookup): AgendaOutcome[] {
  if (v === undefined) return []
  if (!Array.isArray(v)) throw new DataError('결정 내용이 올바르지 않아요')
  const seen = new Set<Id>()
  const clean = v.map((raw): AgendaOutcome | null => {
    if (!isObj(raw)) throw new DataError('결정 내용이 올바르지 않아요')
    const taskId = raw.taskId
    if (typeof taskId !== 'string') throw new DataError('안건에 없는 작업이에요')
    if (!agenda.includes(taskId)) {
      if (l.hasTask(taskId)) throw new DataError('안건에 없는 작업이에요')
      return null // deleted meanwhile: skipped silently
    }
    if (seen.has(taskId)) throw new DataError('같은 작업에 결정이 여러 개 있어요')
    seen.add(taskId)
    switch (raw.action) {
      case 'assign':
        if (typeof raw.memberId !== 'string' || !l.hasMember(raw.memberId)) throw new DataError('팀원을 찾을 수 없어요')
        return { taskId, action: 'assign', memberId: raw.memberId }
      case 'status':
        return { taskId, action: 'status', status: checkStatus(raw.status) }
      case 'backlog':
        return { taskId, action: 'backlog' }
      case 'keep':
        return { taskId, action: 'keep' }
      default:
        throw new DataError('올바르지 않은 결정이에요')
    }
  })
  return clean.filter((o): o is AgendaOutcome => o !== null)
}
