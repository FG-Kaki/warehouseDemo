// Leader election between tabs: only the leader runs demo mode and the member-return timers, so
// several tabs on the same storage don't each simulate teammates. Uses Web Locks when available
// (the lock is released automatically when the leader tab closes) and otherwise a heartbeat lease
// in storage (refreshed every ~3 s, considered dead after ~8 s).
import { LEADER_KEY, type StorageLike } from './storage'

export interface LockManagerLike {
  request(name: string, options: { mode?: 'exclusive'; signal?: AbortSignal }, callback: () => Promise<unknown>): Promise<unknown>
}

export interface Leader {
  /** Whether this tab wants to lead (demo wish or return duty). Leaders that no longer want it step down. */
  want(on: boolean): void
  isLeader(): boolean
  /** Heartbeat / takeover check for the storage lease. Called by an interval, or directly in tests. */
  tick(): void
}

export interface LeaderOptions {
  storage: StorageLike
  now: () => Date
  /** Web Locks manager, or null to force the storage heartbeat. */
  locks: LockManagerLike | null
  /** Run the heartbeat on a real interval. */
  autoRun: boolean
  onChange: (isLeader: boolean) => void
}

export const LEASE_REFRESH_MS = 3000
export const LEASE_DEAD_MS = 8000
const LOCK_NAME = 'office-dashboard:v1:demo-leader'

let tabCounter = 0

export function defaultLocks(): LockManagerLike | null {
  try {
    const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator
    return nav?.locks && typeof nav.locks.request === 'function' ? nav.locks : null
  } catch {
    return null
  }
}

export function createLeader({ storage, now, locks, autoRun, onChange }: LeaderOptions): Leader {
  const me = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${tabCounter++}`
  let wanted = false
  let leader = false
  let interval: ReturnType<typeof setInterval> | null = null

  const set = (value: boolean) => {
    if (leader === value) return
    leader = value
    onChange(value)
  }

  // ---- Web Locks ------------------------------------------------------------
  let requested = false
  let abort: AbortController | null = null
  let releaseLock: (() => void) | null = null

  function lockRequest() {
    if (!locks || requested) return
    requested = true
    abort = new AbortController()
    void locks
      .request(LOCK_NAME, { mode: 'exclusive', signal: abort.signal }, () =>
        new Promise<void>((resolve) => {
          releaseLock = resolve
          set(true)
        }),
      )
      .catch(() => {})
      .finally(() => {
        requested = false
        abort = null
        releaseLock = null
        set(false)
        if (wanted) lockRequest()
      })
  }

  function lockRelease() {
    if (releaseLock) releaseLock()
    else if (abort) abort.abort()
  }

  // ---- storage lease --------------------------------------------------------
  function readLease(): { id: string; at: number } | null {
    try {
      const raw = storage.getItem(LEADER_KEY)
      if (!raw) return null
      const v: unknown = JSON.parse(raw)
      if (typeof v === 'object' && v !== null && 'id' in v && 'at' in v && typeof v.id === 'string' && typeof v.at === 'number') return { id: v.id, at: v.at }
    } catch {
      // treat as no lease
    }
    return null
  }

  function claim() {
    const t = now().getTime()
    const lease = readLease()
    if (lease && lease.id !== me && t - lease.at <= LEASE_DEAD_MS) {
      set(false)
      return
    }
    try {
      storage.setItem(LEADER_KEY, JSON.stringify({ id: me, at: t }))
    } catch {
      // can't write: stay out of it
    }
    set(readLease()?.id === me)
  }

  function leaseRelease() {
    if (readLease()?.id === me) {
      try {
        storage.removeItem(LEADER_KEY)
      } catch {
        // ignore
      }
    }
    set(false)
  }

  function startHeartbeat() {
    if (interval !== null || !autoRun) return
    interval = setInterval(tick, LEASE_REFRESH_MS)
    if (typeof interval === 'object' && interval !== null && 'unref' in interval) (interval as { unref(): void }).unref()
  }

  function stopHeartbeat() {
    if (interval !== null) clearInterval(interval)
    interval = null
  }

  function tick() {
    if (locks) return
    if (wanted) claim()
    else if (leader) leaseRelease()
  }

  if (!locks && storage.subscribe) {
    // the lease was released (leader closed or stepped down): take over right away
    storage.subscribe(LEADER_KEY, (value) => {
      if (value === null && wanted && !leader) claim()
    })
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', () => {
      if (locks) lockRelease()
      else if (leader) leaseRelease()
    })
  }

  return {
    want(on) {
      if (on === wanted) return
      wanted = on
      if (locks) {
        if (on) lockRequest()
        else lockRelease()
      } else if (on) {
        claim()
        startHeartbeat()
      } else {
        stopHeartbeat()
        if (leader) leaseRelease()
      }
    },
    isLeader: () => leader,
    tick,
  }
}
