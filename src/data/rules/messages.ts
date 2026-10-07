// Korean activity messages and josa helpers, shared by the mock source and the server (pure, no I/O).
// `actorName` is set when a simulated teammate / bot acts: the sentence then starts with "{name} 님이 ".
import type { ActivityKind, Id, Presence, Task } from '../types'

const DIGIT_BATCHIM = '013678' // 영 일 삼 육 칠 팔 end in a consonant; 이 사 오 구 do not

/** true when the word's last pronounced syllable ends in a consonant (받침). */
function hasBatchim(word: string): boolean {
  for (let i = word.length - 1; i >= 0; i--) {
    const ch = word[i]
    const code = ch.charCodeAt(0)
    if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0
    if (ch >= '0' && ch <= '9') return DIGIT_BATCHIM.includes(ch)
    if (/[a-zA-Z]/.test(ch)) {
      const tail = word.slice(0, i + 1).toLowerCase()
      return /(l|m|n|ng)$/.test(tail)
    }
    // skip quotes, brackets, punctuation, spaces
  }
  return false
}

export const eul = (word: string) => (hasBatchim(word) ? '을' : '를')
export const iGa = (word: string) => (hasBatchim(word) ? '이' : '가')

/** Shortens a task title for use inside a one-line message. */
export function shortTitle(title: string, max = 22): string {
  const t = title.trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** "WEB-12 '로그인 개선'" */
export function taskText(ref: string, title: string): string {
  return `${ref} '${shortTitle(title)}'`
}

/** "WEB-12 '로그인 개선'을" (particle follows the title). */
export function taskObject(ref: string, title: string): string {
  const t = shortTitle(title)
  return `${ref} '${t}'${eul(t)}`
}

/** "WEB-12을" (particle follows the key, e.g. "OPS-8을", "APP-35를"). */
export function refObject(ref: string): string {
  return `${ref}${eul(ref)}`
}

export function refSubject(ref: string): string {
  return `${ref}${iGa(ref)}`
}

export const STATUS_TO: Record<string, string> = {
  todo: '할 일로',
  in_progress: '진행 중으로',
  review: '검토로',
  done: '완료로',
}

// ---- errors ---------------------------------------------------------------------------

const NOT_FOUND = { task: '작업을 찾을 수 없어요', member: '팀원을 찾을 수 없어요', meeting: '회의를 찾을 수 없어요' } as const
/** The 404 message for a missing task / member / meeting. */
export const notFound = (kind: keyof typeof NOT_FOUND): string => NOT_FOUND[kind]
/** 409 when a meeting is already running (one meeting room). */
export const MEETING_ONGOING = '이미 회의가 진행 중이에요'
/** 409 when ending a meeting that is already over. */
export const MEETING_ENDED = '이미 끝난 회의예요'

// ---- activity builders ----------------------------------------------------------------

export interface ActivityDraft {
  kind: ActivityKind
  message: string
  taskId?: Id
  memberId?: Id
}

const by = (actorName?: string | null) => (actorName ? `${actorName} 님이 ` : '')

export const PRESENCE_MESSAGE: Record<Presence, string> = {
  working: '님이 작업을 시작했어요',
  meeting: '님이 회의에 들어갔어요',
  break: '님이 휴식 중이에요',
  away: '님이 자리를 비웠어요',
}

/** Fields of a task whose change counts as "수정했어요" (as opposed to assign / status / order / agenda). */
export const TASK_CONTENT_KEYS: readonly (keyof Task)[] = ['title', 'description', 'priority', 'estimate', 'projectId', 'dueDate']

export function taskCreatedMessage(ref: string, assigneeName: string | null, actorName?: string | null): string {
  return assigneeName
    ? `${by(actorName)}새 작업 ${refObject(ref)} 만들어 ${assigneeName} 님에게 배정했어요`
    : `${by(actorName)}새 작업 ${refObject(ref)} 만들었어요`
}

export function taskDeletedMessage(ref: string, title: string, actorName?: string | null): string {
  return `${by(actorName)}${taskObject(ref, title)} 삭제했어요`
}

/** Activity for an update that changed `changed` fields of `task` (already patched). null = nothing worth a feed row. */
export function taskChangeActivity(
  task: Task,
  changed: readonly (keyof Task)[],
  ref: string,
  names: { actorId?: Id | null; actorName?: string | null; assigneeName?: string | null },
): ActivityDraft | null {
  const subject = taskObject(ref, task.title)
  const actorName = names.actorName ?? null
  if (changed.includes('assigneeId')) {
    let message: string
    if (!task.assigneeId) message = `${by(actorName)}${subject} 백로그로 돌렸어요`
    else if (actorName && names.actorId === task.assigneeId) message = `${by(actorName)}${subject} 맡았어요`
    else message = `${by(actorName)}${subject} ${names.assigneeName ?? '팀원'} 님에게 배정했어요`
    return { kind: 'task_assigned', message, taskId: task.id, ...(task.assigneeId ? { memberId: task.assigneeId } : {}) }
  }
  if (changed.includes('status')) {
    let message: string
    if (!actorName) message = task.status === 'done' ? `${subject} 완료 처리했어요` : `${subject} ${STATUS_TO[task.status]} 옮겼어요`
    else if (task.status === 'done') {
      const own = task.assigneeId === null || task.assigneeId === names.actorId
      message = own ? `${by(actorName)}${refObject(ref)} 완료했어요` : `${by(actorName)}${refObject(ref)} 검토하고 완료 처리했어요`
    } else if (task.status === 'in_progress') message = `${by(actorName)}${refObject(ref)} 시작했어요`
    else message = `${by(actorName)}${refObject(ref)} ${STATUS_TO[task.status]} 옮겼어요`
    return { kind: 'task_status', message, taskId: task.id }
  }
  if (changed.some((k) => TASK_CONTENT_KEYS.includes(k))) {
    return { kind: 'task_updated', message: `${by(actorName)}${subject} 수정했어요`, taskId: task.id }
  }
  return null
}

export const memberJoinedMessage = (name: string) => `${name} 님이 합류했어요`

/** Presence-only changes read as "{name} 님이 …"; anything else as an info edit. */
export function memberChangeActivity(memberId: Id, name: string, presence: Presence, onlyPresence: boolean): ActivityDraft {
  return onlyPresence
    ? { kind: 'presence', message: `${name} ${PRESENCE_MESSAGE[presence]}`, memberId }
    : { kind: 'member_updated', message: `${name} 님의 정보를 수정했어요`, memberId }
}

export function memberLeftMessage(name: string, movedOpen: number, targetName: string | null): string {
  if (movedOpen === 0) return `${name} 님이 팀을 떠났어요`
  return targetName
    ? `${name} 님이 팀을 떠나 작업 ${movedOpen}개를 ${targetName} 님에게 넘겼어요`
    : `${name} 님이 팀을 떠나 작업 ${movedOpen}개를 백로그로 옮겼어요`
}

export function meetingStartedMessage(title: string, attendees: number, agenda: number, actorName?: string | null): string {
  return `${by(actorName)}${title}${eul(title)} 시작했어요 · 참석 ${attendees}명 · 안건 ${agenda}건`
}

/** `decisions` counts outcomes other than 'keep' (and only those whose task still existed). */
export function meetingEndedMessage(title: string, decisions: number, actorName?: string | null): string {
  return `${by(actorName)}${title}${iGa(title)} 끝났어요 · 결정 ${decisions}건`
}

/** Demo only: a simulated task arriving from outside (not created by a teammate). */
export const demoIncomingMessage = (ref: string) => `새 작업 ${refSubject(ref)} 들어왔어요`
/** Demo only: the informal meeting some teammates wander into. */
export const informalMeetingMessage = (title: string) => `${title} 회의가 시작됐어요`
