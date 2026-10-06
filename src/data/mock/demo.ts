// Demo mode: simulated teammates. Each tick performs at most ONE plausible action through the
// engine's normal mutation path, so changes, activities and persistence behave like real ones.
import { PRIORITY_META } from '../meta'
import { backlogTasks, taskKey, todayIso, workload } from '../selectors'
import type { Estimate, Id, Member, Priority, Task } from '../types'
import { DEMO_TASK_PREFIX, type MockEngine } from './engine'
import type { Leader } from './leader'
import { refObject, refSubject, taskObject } from './text'

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

interface PoolTask {
  p: 'WEB' | 'APP' | 'OPS'
  title: string
  desc: string
  pri: Priority
  est: Estimate
}

const POOL: PoolTask[] = [
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

const MEETINGS = ['디자인 리뷰', '스프린트 계획', '주간 싱크', '기술 설계', '스프린트 회고']

const MAX_DEMO_DONE = 40
const MAX_BACKLOG = 10
/** Real-time gap between demo actions (ms). */
const TICK_MS: [number, number] = [8000, 15000]
/** Chance that a routine move (start / to review) shows up in the activity feed. */
const ROUTINE_FEED_CHANCE = 0.35
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

  const pick = <T>(list: T[]): T => list[Math.min(list.length - 1, Math.floor(random() * list.length))]
  const between = (min: number, max: number) => min + random() * (max - min)
  const refOf = (t: Task) => taskKey(t, engine.ws.projects.find((p) => p.id === t.projectId)?.key)
  const taskFree = (t: Task) => !engine.touchedRecently('task', t.id)
  const memberFree = (m: Member) => !engine.touchedRecently('member', m.id)
  /** Only some routine moves are worth a feed row. */
  const routine = (message: string) => (random() < ROUTINE_FEED_CHANCE ? message : null)

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

  function processReturns(adoptManagerSet: boolean) {
    const ws = engine.ws
    const t = now().getTime()
    if (adoptManagerSet) {
      // Members in a meeting / on a break without a plan (seed, manager) get one, unless the manager just set them.
      for (const m of ws.members) {
        if (engine.getPlans().has(m.id) || !memberFree(m)) continue
        if (m.presence === 'meeting') scheduleReturn(m.id, 'meeting', [20, 40])
        else if (m.presence === 'break') scheduleReturn(m.id, 'break', [15, 30])
      }
    }
    const due: Id[] = []
    for (const [id, r] of [...engine.getPlans()]) {
      const m = ws.members.find((x) => x.id === id)
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
      for (const m of engine.ws.members) {
        if (m.presence === 'working' || engine.getPlans().has(m.id) || !memberFree(m)) continue
        scheduleReturn(m.id, m.presence, [8, 15])
      }
    }
    updateLeadership()
    syncRun()
  }

  // ---- housekeeping ----------------------------------------------------------

  /** Prunes only demo-created ('td_' ids) done tasks, oldest first. Seed and manager tasks stay. */
  function housekeeping() {
    const done = engine.ws.tasks.filter((t) => t.status === 'done' && t.id.startsWith(`${DEMO_TASK_PREFIX}_`))
    if (done.length <= MAX_DEMO_DONE) return
    done.sort((a, b) => (a.completedAt ?? '').localeCompare(b.completedAt ?? ''))
    for (const t of done.slice(0, done.length - MAX_DEMO_DONE)) engine.deleteTask(t.id, { silent: true, demo: true })
  }

  // ---- actions ---------------------------------------------------------------

  interface Candidate {
    name: string
    weight: number
    run: () => void
  }

  function tick(): string | null {
    if (!leader.isLeader()) return null
    processReturns(true)
    const name = act()
    housekeeping()
    return name
  }

  function act(): string | null {
    const ws = engine.ws
    const members = ws.members
    const working = members.filter((m) => m.presence === 'working')
    const movable = working.filter(memberFree)
    const candidates: Candidate[] = []
    const weightOf = (t: Task) => PRIORITY_META[t.priority].weight
    const free = ws.tasks.filter(taskFree)

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
        name: 'start',
        weight: 22,
        run: () => {
          const { m, task } = pick(starters)
          engine.updateTask(task.id, { status: 'in_progress' }, { demo: true, actorId: m.id, message: routine(`${m.name} 님이 ${refObject(refOf(task))} 시작했어요`), kind: 'task_status' })
        },
      })
    }

    // in_progress -> review
    const inProgress = free.filter((t) => t.status === 'in_progress' && working.some((m) => m.id === t.assigneeId))
    if (inProgress.length > 0) {
      candidates.push({
        name: 'review',
        weight: 16,
        run: () => {
          const task = pick(inProgress)
          const m = working.find((x) => x.id === task.assigneeId)!
          engine.updateTask(task.id, { status: 'review' }, { demo: true, actorId: m.id, message: routine(`${m.name} 님이 ${refObject(refOf(task))} 검토로 옮겼어요`), kind: 'task_status' })
        },
      })
    }

    // review -> done: someone (preferably another member) finishes the review.
    const inReview = free.filter((t) => t.status === 'review')
    if (inReview.length > 0 && working.length > 0) {
      candidates.push({
        name: 'done',
        weight: 18,
        run: () => {
          const task = pick(inReview)
          const others = working.filter((m) => m.id !== task.assigneeId)
          const actor = others.length > 0 ? pick(others) : working.find((m) => m.id === task.assigneeId) ?? working[0]
          const ref = refOf(task)
          const message =
            actor.id === task.assigneeId || task.assigneeId === null
              ? `${actor.name} 님이 ${refObject(ref)} 완료했어요`
              : `${actor.name} 님이 ${refObject(ref)} 검토하고 완료 처리했어요`
          engine.updateTask(task.id, { status: 'done' }, { demo: true, actorId: actor.id, message, kind: 'task_status' })
        },
      })
    }

    // backlog -> a light member takes the most important unassigned task.
    const taskRecord: Record<Id, Task> = Object.fromEntries(ws.tasks.map((t) => [t.id, t]))
    const allBacklog = backlogTasks(taskRecord)
    const backlog = allBacklog.filter(taskFree)
    const light = working.map((m) => ({ m, w: workload(m, taskRecord) })).filter((x) => x.w < 0.8)
    if (backlog.length > 0 && light.length > 0) {
      candidates.push({
        name: 'take',
        weight: 14,
        run: () => {
          const lowest = Math.min(...light.map((x) => x.w))
          const { m } = pick(light.filter((x) => x.w === lowest))
          const task = backlog[0]
          engine.updateTask(task.id, { assigneeId: m.id }, { demo: true, actorId: m.id, message: `${m.name} 님이 ${taskObject(refOf(task), task.title)} 맡았어요`, kind: 'task_assigned' })
        },
      })
    }

    // new incoming work, mostly when the backlog runs dry.
    const newWeight = allBacklog.length < 4 ? 26 : allBacklog.length < MAX_BACKLOG ? 5 : 0
    if (newWeight > 0) candidates.push({ name: 'incoming', weight: newWeight, run: createIncoming })

    // presence (never for members the manager just touched)
    const room = Math.floor(members.length / 2) - (members.length - working.length)
    const meetingRunning = [...engine.getPlans().values()].some((r) => r.presence === 'meeting')
    if (!meetingRunning && room >= 2 && movable.length >= 3) {
      candidates.push({
        name: 'meeting',
        weight: 3,
        run: () => {
          const k = Math.min(room, 2 + Math.floor(random() * 2))
          const pool = [...movable]
          const group: Member[] = []
          while (group.length < k && pool.length > 0) group.push(pool.splice(Math.floor(random() * pool.length), 1)[0])
          const title = pick(MEETINGS)
          for (const m of group) scheduleReturn(m.id, 'meeting', [20, 40])
          engine.setPresence(group.map((m) => m.id), 'meeting', { message: `${title} 회의가 시작됐어요`, memberId: group[0].id })
        },
      })
    }
    if (room >= 1 && movable.length > 0) {
      candidates.push({
        name: 'break',
        weight: 5,
        run: () => {
          const m = pick(movable)
          scheduleReturn(m.id, 'break', [15, 30])
          engine.setPresence([m.id], 'break')
        },
      })
      candidates.push({
        name: 'away',
        weight: 1,
        run: () => {
          const m = pick(movable)
          scheduleReturn(m.id, 'away', [40, 70])
          engine.setPresence([m.id], 'away')
        },
      })
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
    chosen.run()
    return chosen.name
  }

  function createIncoming() {
    const ws = engine.ws
    const item = pick(POOL)
    const project = ws.projects.find((p) => p.key === item.p) ?? ws.projects[0]
    if (!project) return
    // Re-use the pool with a numbered suffix once a title already exists.
    const same = ws.tasks.filter((t) => t.title === item.title || t.title.startsWith(`${item.title} `)).length
    const title = same > 0 ? `${item.title} ${same + 1}차` : item.title
    let dueDate: string | null = null
    if (random() > 0.3) {
      const d = new Date(now())
      d.setDate(d.getDate() + 3 + Math.floor(random() * 12))
      dueDate = todayIso(d)
    }
    const ref = `${project.key}-${engine.nextNumber}`
    engine.createTask(
      { title, projectId: project.id, description: item.desc, priority: item.pri, estimate: item.est, dueDate },
      { demo: true, actorId: null, message: `새 작업 ${refSubject(ref)} 들어왔어요`, kind: 'task_created' },
    )
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
    }, between(TICK_MS[0], TICK_MS[1]))
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
