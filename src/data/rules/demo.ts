// Demo mode rules shared by the mock source's demo and the server's bot: the incoming-work pool,
// weights and timings, and a pure "what would a simulated teammate do next" function. The caller
// performs the action (the mock through its engine, the bot through HTTP) and owns the timers.
import { PRIORITY_META } from '../meta'
import { backlogTasks, todayIso, workload } from '../selectors'
import { DEMO_TASK_PREFIX, isDemoTaskId } from './constants'
import type { Estimate, Id, Member, Priority, Project, Task, TaskInput, Workspace } from '../types'

export interface PoolTask {
  p: 'WEB' | 'APP' | 'OPS'
  title: string
  desc: string
  pri: Priority
  est: Estimate
}

export const POOL: PoolTask[] = [
  { p: 'WEB', title: '회원 탈퇴 플로우 점검', desc: '탈퇴 전 안내 문구와 데이터 삭제 시점을 확인하고 누락된 화면을 정리합니다.', pri: 'medium', est: 3 },
  { p: 'WEB', title: '상품 리뷰 작성 화면 개선', desc: '별점과 사진 첨부를 한 화면에서 끝낼 수 있게 입력 흐름을 단순화합니다.', pri: 'medium', est: 5 },
  { p: 'WEB', title: '이메일 인증 메일 템플릿 정리', desc: '인증, 비밀번호 재설정 메일의 문구와 디자인을 통일합니다.', pri: 'low', est: 2 },
  { p: 'WEB', title: '위시리스트 기능 추가', desc: '상품 카드에서 하트를 눌러 찜하고 마이페이지에서 모아 볼 수 있게 합니다.', pri: 'medium', est: 5 },
  { p: 'WEB', title: '공지사항 게시판 페이지 구현', desc: '관리자가 올린 공지를 목록과 상세로 보여주는 페이지를 만듭니다.', pri: 'low', est: 3 },
  { p: 'WEB', title: '페이지 로딩 속도 측정 및 개선', desc: '주요 화면의 LCP를 측정하고 이미지와 번들 크기부터 줄입니다.', pri: 'high', est: 5 },
  { p: 'WEB', title: '약관 동의 화면 문구 수정', desc: '법무팀 검토를 반영해 약관 동의 화면의 문구를 바꿉니다.', pri: 'high', est: 1 },
  { p: 'WEB', title: '관리자 주문 취소 기능 추가', desc: '운영자가 주문을 취소하고 환불 사유를 남길 수 있게 합니다.', pri: 'high', est: 3 },
  { p: 'APP', title: '앱 시작 속도 개선', desc: '콜드 스타트 시간을 측정하고 초기화 작업을 지연 로딩으로 옮깁니다.', pri: 'high', est: 5 },
  { p: 'APP', title: '생체 인증 로그인 지원', desc: '지문과 얼굴 인식으로 간편하게 로그인할 수 있게 합니다.', pri: 'medium', est: 5 },
  { p: 'APP', title: '장바구니 화면 스와이프 삭제', desc: '장바구니 항목을 왼쪽으로 밀어 삭제하고 되돌리기를 제공합니다.', pri: 'low', est: 2 },
  { p: 'APP', title: '앱 내 검색 최근 검색어 저장', desc: '최근 검색어를 기기에 저장하고 개별 삭제와 전체 삭제를 지원합니다.', pri: 'low', est: 2 },
  { p: 'APP', title: '배송 조회 화면 구현', desc: '택배사 연동 정보를 받아 배송 단계를 타임라인으로 보여줍니다.', pri: 'medium', est: 5 },
  { p: 'APP', title: '태블릿 레이아웃 대응', desc: '넓은 화면에서 목록과 상세를 나란히 보여주는 레이아웃을 추가합니다.', pri: 'low', est: 8 },
  { p: 'APP', title: '리뷰 사진 업로드 용량 제한', desc: '큰 사진은 업로드 전에 줄이고 실패 시 안내 문구를 보여줍니다.', pri: 'medium', est: 2 },
  { p: 'APP', title: '딥링크 연결 오류 수정', desc: '마케팅 링크로 앱을 열었을 때 상품 화면으로 가지 않는 문제를 고칩니다.', pri: 'urgent', est: 3 },
  { p: 'OPS', title: '서버 로그 보관 기간 정책 정리', desc: '서비스별 로그 보관 기간과 비용을 비교해 기준을 정합니다.', pri: 'low', est: 2 },
  { p: 'OPS', title: 'SSL 인증서 만료 알림 설정', desc: '인증서 만료 30일, 7일 전에 팀 채널로 알림이 오도록 합니다.', pri: 'high', est: 2 },
  { p: 'OPS', title: '데이터베이스 슬로 쿼리 점검', desc: '지난 주 슬로 쿼리 로그에서 상위 10개를 골라 원인을 분석합니다.', pri: 'medium', est: 3 },
  { p: 'OPS', title: '배포 롤백 절차 문서화', desc: '문제가 생겼을 때 5분 안에 이전 버전으로 돌아가는 절차를 정리합니다.', pri: 'high', est: 3 },
  { p: 'OPS', title: '개발 환경 컨테이너 이미지 갱신', desc: '오래된 베이스 이미지를 최신 버전으로 올리고 빌드 시간을 비교합니다.', pri: 'low', est: 3 },
  { p: 'OPS', title: '장애 대응 매뉴얼 업데이트', desc: '최근 장애 사례를 반영해 연락 체계와 단계별 대응을 고칩니다.', pri: 'medium', est: 2 },
  { p: 'OPS', title: '비밀 키 로테이션 자동화', desc: '외부 서비스 키를 주기적으로 교체하는 작업을 스크립트로 만듭니다.', pri: 'medium', est: 5 },
  { p: 'OPS', title: 'CDN 캐시 규칙 점검', desc: '정적 파일 캐시 기간이 맞는지 확인하고 불필요한 무효화를 줄입니다.', pri: 'low', est: 2 },
]

/** Titles of the informal meetings the mock demo sends people to. */
export const MEETING_TITLES = ['디자인 리뷰', '스프린트 계획', '주간 싱크', '기술 설계', '스프린트 회고']

export { DEMO_TASK_PREFIX }
export const MAX_DEMO_DONE = 40
export const MAX_BACKLOG = 10
/** Real-time gap between demo actions (ms). */
export const DEMO_TICK_MS: [number, number] = [8000, 15000]
/** Chance that a routine move (start / to review) shows up in the activity feed. */
export const ROUTINE_FEED_CHANCE = 0.35
/** How long (seconds) the demo keeps somebody away before they go back to work. */
export const RETURN_SECONDS = {
  meeting: [20, 40],
  break: [15, 30],
  away: [40, 70],
  /** Someone found away / in a meeting / on a break with no planned return (seed, manager). */
  adopt: [8, 15],
} as const satisfies Record<string, [number, number]>

export type DemoAction =
  /** todo -> in_progress. `feed`: whether it leaves a feed row. */
  | { name: 'start'; actorId: Id; taskId: Id; feed: boolean }
  | { name: 'review'; actorId: Id; taskId: Id; feed: boolean }
  | { name: 'done'; actorId: Id; taskId: Id }
  | { name: 'take'; actorId: Id; taskId: Id }
  /** `actorId` only when requested (the bot posts as a teammate; the mock demo has no actor). */
  | { name: 'incoming'; actorId: Id | null; task: TaskInput; ref: string }
  | { name: 'meeting'; memberIds: Id[]; title: string }
  | { name: 'break'; memberId: Id }
  | { name: 'away'; memberId: Id }

export interface DemoInput {
  ws: Pick<Workspace, 'projects' | 'members' | 'tasks' | 'meetings'>
  now: Date
  random: () => number
  /** The next task number (for the "새 작업 WEB-122가 들어왔어요" reference). Default: highest + 1. */
  nextNumber?: number
  /** False for tasks the manager touched recently. Open agenda tasks are never free regardless. */
  isTaskFree?: (t: Task) => boolean
  /** False for members the manager touched recently (their presence is left alone). */
  isMemberFree?: (m: Member) => boolean
  /** A planned return for an informal meeting exists: no second informal meeting. */
  informalMeetingPlanned?: boolean
  /** Pick a teammate to post incoming work as (the bot needs one; the mock demo does not). */
  incomingActor?: boolean
}

/** Whether the demo may still use a task: not on the agenda (the team lead's), not touched by the manager. */
export const demoTaskFree = (t: Task, isTaskFree?: (t: Task) => boolean) => !t.onAgenda && (isTaskFree ? isTaskFree(t) : true)

/**
 * Picks the next simulated action over a workspace snapshot, or null when nothing is feasible.
 * Respects manager touches, open agenda tasks and the attendees of an ongoing meeting (their presence
 * is never changed, and no informal meeting starts while a real one runs). The sequence of `random()`
 * calls is part of the behaviour (seeded tests rely on it).
 */
export function planDemoAction(input: DemoInput): DemoAction | null {
  const { ws, now, random } = input
  const pick = <T>(list: T[]): T => list[Math.min(list.length - 1, Math.floor(random() * list.length))]
  const members = ws.members
  const inMeeting = new Set(ws.meetings.filter((m) => m.status === 'ongoing').flatMap((m) => m.attendeeIds))
  const working = members.filter((m) => m.presence === 'working')
  const movable = working.filter((m) => !inMeeting.has(m.id) && (input.isMemberFree ? input.isMemberFree(m) : true))
  const weightOf = (t: Task) => PRIORITY_META[t.priority].weight
  const free = ws.tasks.filter((t) => demoTaskFree(t, input.isTaskFree))
  const routine = () => random() < ROUTINE_FEED_CHANCE

  const candidates: { weight: number; run: () => DemoAction | null }[] = []

  // todo -> in_progress: a working member with nothing in progress starts their best todo.
  const starters = working
    .filter((m) => !ws.tasks.some((t) => t.assigneeId === m.id && t.status === 'in_progress'))
    .map((m) => ({
      m,
      task: free
        .filter((t) => t.assigneeId === m.id && t.status === 'todo')
        .sort((a, b) => weightOf(b) - weightOf(a) || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.order - b.order)[0],
    }))
    .filter((x) => x.task)
  if (starters.length > 0) {
    candidates.push({
      weight: 22,
      run: () => {
        const { m, task } = pick(starters)
        return { name: 'start', actorId: m.id, taskId: task.id, feed: routine() }
      },
    })
  }

  // in_progress -> review
  const inProgress = free.filter((t) => t.status === 'in_progress' && working.some((m) => m.id === t.assigneeId))
  if (inProgress.length > 0) {
    candidates.push({
      weight: 16,
      run: () => {
        const task = pick(inProgress)
        return { name: 'review', actorId: task.assigneeId!, taskId: task.id, feed: routine() }
      },
    })
  }

  // review -> done: someone (preferably another member) finishes the review.
  const inReview = free.filter((t) => t.status === 'review')
  if (inReview.length > 0 && working.length > 0) {
    candidates.push({
      weight: 18,
      run: () => {
        const task = pick(inReview)
        const others = working.filter((m) => m.id !== task.assigneeId)
        const actor = others.length > 0 ? pick(others) : working.find((m) => m.id === task.assigneeId) ?? working[0]
        return { name: 'done', actorId: actor.id, taskId: task.id }
      },
    })
  }

  // backlog -> a light member takes the most important unassigned task.
  const record: Record<Id, Task> = Object.fromEntries(ws.tasks.map((t) => [t.id, t]))
  const backlog = backlogTasks(record).filter((t) => demoTaskFree(t, input.isTaskFree))
  const light = working.map((m) => ({ m, w: workload(m, record) })).filter((x) => x.w < 0.8)
  if (backlog.length > 0 && light.length > 0) {
    candidates.push({
      weight: 14,
      run: () => {
        const lowest = Math.min(...light.map((x) => x.w))
        const { m } = pick(light.filter((x) => x.w === lowest))
        return { name: 'take', actorId: m.id, taskId: backlog[0].id }
      },
    })
  }

  // new incoming work, mostly when the backlog runs dry.
  // (only free backlog counts: agenda items belong to the team lead and are not available work)
  const newWeight = backlog.length < 4 ? 26 : backlog.length < MAX_BACKLOG ? 5 : 0
  if (newWeight > 0 && (!input.incomingActor || members.length > 0)) {
    candidates.push({
      weight: newWeight,
      run: () => {
        const actorId = input.incomingActor ? (working.length > 0 ? pick(working) : pick(members)).id : null
        return planIncoming(ws, now, random, input.nextNumber, actorId)
      },
    })
  }

  // presence (never for members the manager just touched, nor for a running meeting's attendees)
  const room = Math.floor(members.length / 2) - (members.length - working.length)
  const realMeeting = inMeeting.size > 0 || ws.meetings.some((m) => m.status === 'ongoing')
  if (!input.informalMeetingPlanned && !realMeeting && room >= 2 && movable.length >= 3) {
    candidates.push({
      weight: 3,
      run: () => {
        const k = Math.min(room, 2 + Math.floor(random() * 2))
        const pool = [...movable]
        const group: Member[] = []
        while (group.length < k && pool.length > 0) group.push(pool.splice(Math.floor(random() * pool.length), 1)[0])
        return { name: 'meeting', memberIds: group.map((m) => m.id), title: pick(MEETING_TITLES) }
      },
    })
  }
  if (room >= 1 && movable.length > 0) {
    candidates.push({ weight: 5, run: () => ({ name: 'break', memberId: pick(movable).id }) })
    candidates.push({ weight: 1, run: () => ({ name: 'away', memberId: pick(movable).id }) })
  }

  const total = candidates.reduce((s, c) => s + c.weight, 0)
  if (total <= 0) return null
  let r = random() * total
  let chosen = candidates[candidates.length - 1]
  for (const c of candidates) {
    r -= c.weight
    if (r < 0) {
      chosen = c
      break
    }
  }
  return chosen.run()
}

/** A new task from the pool; re-uses titles with a numbered suffix once one already exists. */
function planIncoming(ws: DemoInput['ws'], now: Date, random: () => number, nextNumber: number | undefined, actorId: Id | null): DemoAction | null {
  const item = POOL[Math.min(POOL.length - 1, Math.floor(random() * POOL.length))]
  const project: Project | undefined = ws.projects.find((p) => p.key === item.p) ?? ws.projects[0]
  if (!project) return null
  const same = ws.tasks.filter((t) => t.title === item.title || t.title.startsWith(`${item.title} `)).length
  const title = same > 0 ? `${item.title} ${same + 1}차` : item.title
  let dueDate: string | null = null
  if (random() > 0.3) {
    const d = new Date(now)
    d.setDate(d.getDate() + 3 + Math.floor(random() * 12))
    dueDate = todayIso(d)
  }
  const number = nextNumber ?? Math.max(0, ...ws.tasks.map((t) => t.number)) + 1
  const ref = `${project.key}-${number}`
  return { name: 'incoming', actorId, task: { title, projectId: project.id, description: item.desc, priority: item.pri, estimate: item.est, dueDate }, ref }
}

/** Demo-created done tasks beyond the cap, oldest first: the ones housekeeping should delete. */
export function demoTasksToPrune(tasks: readonly Task[]): Task[] {
  const done = tasks.filter((t) => t.status === 'done' && isDemoTaskId(t.id))
  if (done.length <= MAX_DEMO_DONE) return []
  done.sort((a, b) => (a.completedAt ?? '').localeCompare(b.completedAt ?? ''))
  return done.slice(0, done.length - MAX_DEMO_DONE)
}
