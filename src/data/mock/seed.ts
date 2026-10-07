// Seed data: a realistic Korean product team, all dates relative to "now".
import { MEMBER_COLORS } from '../meta'
import { taskKey, todayIso } from '../selectors'
import type { Activity, ActivityKind, Estimate, Member, Presence, Priority, Project, Task, TaskStatus } from '../types'
import { OFFICE } from '../../office/layout'
import { refObject, STATUS_TO, taskObject } from './text'
import type { Persisted } from './storage'

const DAY = 86_400_000
const HOUR = 3_600_000

// Colors chosen to differ from the status / priority colors in meta.ts.
const PROJECTS: Project[] = [
  { id: 'p_web', key: 'WEB', name: '웹 리뉴얼', color: '#00b8d4' },
  { id: 'p_app', key: 'APP', name: '모바일 앱', color: '#8bc34a' },
  { id: 'p_ops', key: 'OPS', name: '인프라 개선', color: '#a1724e' },
]

interface SeedMember {
  name: string
  role: string
  capacity: number
  desk: string
  presence: Presence
  variant: number
  joinedDaysAgo: number
}

// Workloads (open points / capacity): 김하늘 .80, 이도윤 1.40 (overloaded), 박서연 .88, 최민준 .83,
// 정유진 .40 (light), 한지우 .78, 강태양 .85. Desks A5, B4, B5 stay free.
const MEMBERS: SeedMember[] = [
  { name: '김하늘', role: '프론트엔드', capacity: 10, desk: 'A1', presence: 'working', variant: 0, joinedDaysAgo: 420 },
  { name: '이도윤', role: '백엔드', capacity: 10, desk: 'A2', presence: 'working', variant: 1, joinedDaysAgo: 610 },
  { name: '박서연', role: '디자인', capacity: 8, desk: 'A3', presence: 'meeting', variant: 2, joinedDaysAgo: 300 },
  { name: '최민준', role: '모바일', capacity: 12, desk: 'A4', presence: 'working', variant: 3, joinedDaysAgo: 250 },
  { name: '정유진', role: 'QA', capacity: 10, desk: 'B1', presence: 'working', variant: 4, joinedDaysAgo: 180 },
  { name: '한지우', role: '데이터', capacity: 9, desk: 'B2', presence: 'break', variant: 5, joinedDaysAgo: 120 },
  { name: '강태양', role: 'DevOps', capacity: 13, desk: 'B3', presence: 'working', variant: 1, joinedDaysAgo: 500 },
]

interface SeedTask {
  p: 'WEB' | 'APP' | 'OPS'
  title: string
  desc: string
  status: TaskStatus
  pri: Priority
  est: Estimate
  /** 1-based member index, 0 = unassigned. */
  who: number
  /** Days from today (negative = overdue), or null. */
  due: number | null
  /** Done tasks: how many days ago it was completed. */
  done?: number
}

// Index + 1 = task number. Numbers 1..10 are done, 11..30 assigned, 31..36 backlog.
const TASKS: SeedTask[] = [
  { p: 'WEB', title: '메인 페이지 히어로 영역 개편', desc: '새 브랜드 가이드에 맞춰 메인 배너와 CTA 버튼 배치를 정리합니다. 모바일에서도 첫 화면에 핵심 문구가 보여야 해요.', status: 'done', pri: 'high', est: 5, who: 3, due: null, done: 9 },
  { p: 'OPS', title: 'CI 파이프라인 캐시 적용', desc: '의존성 설치 단계에 캐시를 붙여 빌드 시간을 절반 수준으로 줄입니다.', status: 'done', pri: 'medium', est: 3, who: 7, due: null, done: 8 },
  { p: 'APP', title: '온보딩 화면 3단계 구현', desc: '첫 실행 시 보여줄 소개 화면 3장과 건너뛰기 동작을 구현합니다.', status: 'done', pri: 'medium', est: 5, who: 4, due: null, done: 6 },
  { p: 'WEB', title: '회원가입 폼 유효성 검사 개선', desc: '이메일 중복 확인과 비밀번호 규칙 안내를 입력 중에 바로 보여주도록 바꿉니다.', status: 'done', pri: 'medium', est: 3, who: 1, due: null, done: 5 },
  { p: 'APP', title: '푸시 알림 수신 테스트 케이스 작성', desc: '앱 상태(전경/후면/종료)별 푸시 수신 시나리오를 정리하고 체크리스트로 만듭니다.', status: 'done', pri: 'low', est: 2, who: 5, due: null, done: 3 },
  { p: 'OPS', title: '로그 수집 대시보드 구축', desc: '서비스별 에러 로그를 한 화면에서 볼 수 있는 대시보드를 만듭니다.', status: 'done', pri: 'high', est: 5, who: 6, due: null, done: 2.5 },
  { p: 'WEB', title: '상품 목록 API 응답 속도 개선', desc: '느린 쿼리에 인덱스를 추가하고 목록 응답 크기를 줄입니다.', status: 'done', pri: 'high', est: 5, who: 2, due: null, done: 1.9 },
  { p: 'APP', title: '결제 모듈 샌드박스 연동', desc: '결제 대행사 샌드박스 환경과 연결해 테스트 결제가 가능하도록 합니다.', status: 'done', pri: 'urgent', est: 3, who: 2, due: null, done: 1.2 },
  { p: 'WEB', title: '로그인 실패 메시지 문구 정리', desc: '오류 원인별로 사용자에게 보여줄 안내 문구를 통일합니다.', status: 'done', pri: 'low', est: 1, who: 1, due: null, done: 0.8 },
  { p: 'WEB', title: '모바일 웹 브레이크포인트 점검', desc: '320px~768px 구간에서 깨지는 레이아웃을 찾아 목록으로 정리합니다.', status: 'done', pri: 'medium', est: 2, who: 5, due: null, done: 0.3 },

  { p: 'WEB', title: '장바구니 UI 리뉴얼', desc: '수량 변경과 쿠폰 입력을 한 화면에서 처리할 수 있게 장바구니를 다시 디자인대로 구현합니다.', status: 'in_progress', pri: 'high', est: 3, who: 1, due: 2 },
  { p: 'WEB', title: '로그인 세션 유지 시간 조정', desc: '자동 로그인 유지 기간을 14일로 늘리고 만료 직전 안내 토스트를 추가합니다.', status: 'review', pri: 'medium', est: 2, who: 1, due: 1 },
  { p: 'APP', title: '상품 상세 화면 이미지 갤러리', desc: '스와이프로 넘기는 이미지 갤러리와 확대 보기를 구현합니다. 이미지가 많을 때 메모리 사용량에 주의해 주세요.', status: 'in_progress', pri: 'high', est: 5, who: 4, due: 4 },
  { p: 'OPS', title: '쿠버네티스 노드 오토스케일링 설정', desc: '트래픽이 몰리는 시간대에 노드가 자동으로 늘고 줄도록 정책을 설정합니다.', status: 'in_progress', pri: 'urgent', est: 3, who: 7, due: 1 },
  { p: 'OPS', title: '모니터링 알림 임계값 재설정', desc: '불필요한 알림을 줄이기 위해 CPU와 지연 시간 임계값을 최근 한 달 데이터로 다시 잡습니다.', status: 'review', pri: 'medium', est: 3, who: 7, due: 0 },
  { p: 'WEB', title: '주문 내역 조회 API 페이지네이션', desc: '주문이 많은 고객도 빠르게 볼 수 있도록 커서 기반 페이지네이션을 도입합니다.', status: 'in_progress', pri: 'high', est: 5, who: 2, due: 3 },
  { p: 'APP', title: '결제 실패 시 재시도 흐름', desc: '결제 실패 사유별로 안내 문구와 재시도 버튼 동작을 정의하고 서버 응답 코드를 맞춥니다.', status: 'in_progress', pri: 'urgent', est: 3, who: 2, due: 2 },
  { p: 'WEB', title: '상품 상세 페이지 디자인 시안', desc: '리뉴얼 톤에 맞춘 상품 상세 시안 2종을 만들어 팀 리뷰를 받습니다.', status: 'in_progress', pri: 'high', est: 3, who: 3, due: 2 },
  { p: 'APP', title: '앱 아이콘과 스플래시 리뉴얼', desc: '새 로고를 반영한 아이콘과 스플래시 화면을 제작해 전달합니다.', status: 'review', pri: 'medium', est: 2, who: 3, due: 5 },
  { p: 'OPS', title: '사용자 행동 로그 집계 쿼리 최적화', desc: '일간 집계 쿼리가 40분 넘게 걸립니다. 파티션과 중간 테이블로 10분 이내를 목표로 해요.', status: 'in_progress', pri: 'high', est: 5, who: 6, due: -2 },
  { p: 'OPS', title: '주간 지표 리포트 자동화', desc: '매주 월요일 아침 팀 채널로 핵심 지표 요약이 자동 발송되도록 만듭니다.', status: 'review', pri: 'medium', est: 2, who: 6, due: 3 },
  { p: 'WEB', title: '결제 완료 페이지 QA 시나리오 작성', desc: '결제 수단별 완료 화면과 실패 후 재진입 시나리오를 정리합니다.', status: 'in_progress', pri: 'medium', est: 2, who: 5, due: 3 },
  { p: 'WEB', title: '쿠폰 적용 로직 서버 검증', desc: '클라이언트에서만 확인하던 쿠폰 조건을 서버에서도 검증해 중복 적용을 막습니다.', status: 'todo', pri: 'high', est: 3, who: 2, due: -3 },
  { p: 'APP', title: '오프라인 모드 캐시 정책', desc: '네트워크가 끊겼을 때 최근 본 상품과 주문 내역을 보여줄 캐시 범위를 정합니다.', status: 'todo', pri: 'medium', est: 3, who: 4, due: -1 },
  { p: 'APP', title: '다크 모드 색상 토큰 정리', desc: '라이트/다크 공용 색상 토큰을 정의하고 디자인 파일에 반영합니다.', status: 'todo', pri: 'low', est: 2, who: 3, due: 8 },
  { p: 'OPS', title: '스테이징 환경 배포 자동화', desc: 'main 브랜치에 머지되면 스테이징에 자동 배포되도록 파이프라인을 확장합니다.', status: 'todo', pri: 'medium', est: 5, who: 7, due: 10 },
  { p: 'WEB', title: '검색 자동완성 응답 캐싱', desc: '인기 검색어 자동완성 응답을 짧게 캐싱해 서버 부하를 줄입니다.', status: 'todo', pri: 'medium', est: 3, who: 2, due: 7 },
  { p: 'WEB', title: '접근성 점검 및 개선 항목 정리', desc: '스크린리더와 키보드 이동 기준으로 주요 화면을 점검하고 개선 항목을 목록화합니다.', status: 'todo', pri: 'low', est: 3, who: 1, due: 12 },
  { p: 'APP', title: '앱 푸시 알림 설정 화면', desc: '알림 종류별 켜기/끄기 토글과 방해 금지 시간 설정 화면을 추가합니다.', status: 'todo', pri: 'medium', est: 2, who: 4, due: 6 },
  { p: 'APP', title: '회귀 테스트 자동화 스크립트', desc: '릴리스 전에 반복 수행하는 핵심 시나리오 10개를 자동 실행 스크립트로 옮깁니다.', status: 'todo', pri: 'medium', est: 2, who: 5, due: 9 },

  { p: 'WEB', title: '관리자 페이지 권한 체계 정리', desc: '운영자, 매니저, 조회 전용 등 역할별 접근 범위를 표로 정리하고 구현 범위를 나눕니다.', status: 'todo', pri: 'medium', est: 5, who: 0, due: 14 },
  { p: 'APP', title: '앱 스토어 심사 대응 체크리스트', desc: '지난 심사에서 반려된 항목을 모아 제출 전 점검 목록으로 만듭니다.', status: 'todo', pri: 'high', est: 3, who: 0, due: 5 },
  { p: 'OPS', title: '데이터베이스 백업 복구 훈련', desc: '백업본으로 실제 복구를 해보고 걸린 시간과 문제점을 기록합니다.', status: 'todo', pri: 'high', est: 5, who: 0, due: 11 },
  { p: 'WEB', title: '블로그 SEO 메타 태그 점검', desc: '제목, 설명, 오픈그래프 태그가 빠진 페이지를 찾아 정리합니다.', status: 'todo', pri: 'low', est: 1, who: 0, due: null },
  { p: 'APP', title: '크래시 리포트 분석 및 우선순위 정리', desc: '지난 2주간 크래시 상위 10건을 분석해 원인과 담당 영역을 나눕니다.', status: 'todo', pri: 'urgent', est: 3, who: 0, due: 2 },
  { p: 'OPS', title: '미사용 클라우드 리소스 정리', desc: '사용하지 않는 볼륨과 오래된 스냅샷을 찾아 비용을 줄입니다.', status: 'todo', pri: 'low', est: 2, who: 0, due: null },
]

// Open tasks already on the agenda for the next meeting, so the feature is visible on first load:
// 20 = the overdue log-aggregation query, 35 = the urgent crash-report triage (backlog).
const AGENDA_NUMBERS = [20, 35]

interface SeedEvent {
  /** Hours before now. */
  h: number
  kind: ActivityKind
  /** Task number, when the event is about a task. */
  task?: number
  /** 1-based member index acting (0/undefined = the manager). */
  by?: number
  /** For assignments / presence: the member concerned. */
  to?: number
  /** Custom message. */
  text?: string
}

// ~22 entries over the last two days, consistent with the task table above.
const EVENTS: SeedEvent[] = [
  { h: 45.6, kind: 'task_status', task: 7, by: 2 },
  { h: 44, kind: 'task_assigned', task: 23, to: 2 },
  { h: 40, kind: 'task_created', task: 31 },
  { h: 36, kind: 'task_status', task: 13, by: 4 },
  { h: 30, kind: 'task_status', task: 11, by: 1 },
  { h: 28.8, kind: 'task_status', task: 8, by: 2 },
  { h: 27, kind: 'task_assigned', task: 20, to: 6 },
  { h: 26, kind: 'task_status', task: 14, by: 7 },
  { h: 24, kind: 'task_status', task: 20, by: 6 },
  { h: 22, kind: 'task_status', task: 22, by: 5 },
  { h: 20, kind: 'task_created', task: 35 },
  { h: 19.2, kind: 'task_status', task: 9, by: 1 },
  { h: 18, kind: 'task_status', task: 19, by: 3 },
  { h: 16, kind: 'task_status', task: 15, by: 7 },
  { h: 14, kind: 'task_status', task: 12, by: 1 },
  { h: 12, kind: 'task_assigned', task: 17, to: 2 },
  { h: 10, kind: 'task_status', task: 21, by: 6 },
  { h: 7.2, kind: 'task_status', task: 10, by: 5 },
  { h: 5, kind: 'task_created', task: 36 },
  { h: 3, kind: 'presence', to: 6, text: '한지우 님이 휴식 중이에요' },
  { h: 1, kind: 'presence', to: 3, text: '디자인 리뷰 회의가 시작됐어요' },
]

const iso = (ms: number) => new Date(ms).toISOString()

export function buildSeed(now: Date): Persisted {
  const t0 = now.getTime()
  const dueDate = (offset: number | null): string | null => {
    if (offset === null) return null
    const d = new Date(now)
    d.setDate(d.getDate() + offset)
    return todayIso(d)
  }

  const members: Member[] = MEMBERS.map((m, i) => {
    if (!OFFICE.desks.some((d) => d.id === m.desk)) throw new Error(`seed: unknown desk ${m.desk}`)
    return {
      id: `m_${i + 1}`,
      name: m.name,
      role: m.role,
      color: MEMBER_COLORS[i % MEMBER_COLORS.length],
      capacity: m.capacity,
      deskId: m.desk,
      presence: m.presence,
      avatarVariant: m.variant,
      joinedAt: iso(t0 - m.joinedDaysAgo * DAY),
    }
  })
  const memberOf = (idx: number) => members[idx - 1]

  const stackCounter = new Map<string, number>()
  const tasks: Task[] = TASKS.map((s, i) => {
    const number = i + 1
    const assigneeId = s.who === 0 ? null : memberOf(s.who).id
    const stackKey = assigneeId ?? 'backlog'
    const order = (stackCounter.get(stackKey) ?? 0) + 1
    stackCounter.set(stackKey, order)
    const project = PROJECTS.find((p) => p.key === s.p)!
    const isDone = s.status === 'done'
    const completedMs = isDone ? t0 - (s.done ?? 1) * DAY : null
    const createdAgo = isDone ? (s.done ?? 1) + 2 + (number % 4) : 1 + (TASKS.length - number) * 0.45
    const createdMs = t0 - createdAgo * DAY
    const updatedMs = completedMs ?? t0 - Math.min(createdAgo, (number % 5) * 0.35 + 0.1) * DAY
    return {
      id: `t_${number}`,
      number,
      title: s.title,
      description: s.desc,
      status: s.status,
      priority: s.pri,
      estimate: s.est,
      projectId: project.id,
      assigneeId,
      dueDate: dueDate(s.due),
      order,
      createdAt: iso(createdMs),
      updatedAt: iso(updatedMs),
      completedAt: completedMs === null ? null : iso(completedMs),
      onAgenda: AGENDA_NUMBERS.includes(number),
    }
  })
  const taskOf = (number: number) => tasks[number - 1]
  const refOf = (t: Task) => taskKey(t, PROJECTS.find((p) => p.id === t.projectId)?.key)

  const activity: Activity[] = EVENTS.map((e, i) => {
    const at = iso(t0 - e.h * HOUR)
    const t = e.task ? taskOf(e.task) : undefined
    const actor = e.by ? memberOf(e.by) : undefined
    let message = e.text ?? ''
    if (t && !e.text) {
      const ref = refOf(t)
      if (e.kind === 'task_created') message = `새 작업 ${refObject(ref)} 만들었어요`
      else if (e.kind === 'task_assigned') message = `${taskObject(ref, t.title)} ${memberOf(e.to!).name} 님에게 배정했어요`
      else if (t.status === 'done') message = `${actor!.name} 님이 ${refObject(ref)} 완료했어요`
      else message = `${actor!.name} 님이 ${refObject(ref)} ${STATUS_TO[t.status]} 옮겼어요`
    }
    const entry: Activity = {
      id: `a_s${String(i + 1).padStart(2, '0')}`,
      at,
      kind: e.kind,
      actorId: actor ? actor.id : null,
      message,
    }
    if (t) entry.taskId = t.id
    if (e.kind === 'task_assigned' || e.kind === 'presence') entry.memberId = memberOf(e.to!).id
    else if (actor) entry.memberId = actor.id
    return entry
  })

  return {
    version: 1,
    workspace: { projects: PROJECTS.map((p) => ({ ...p })), members, tasks, meetings: [], activity },
    nextNumber: TASKS.length + 1,
  }
}
