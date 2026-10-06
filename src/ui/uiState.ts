// UI-only view state (panel layout etc.). Domain state stays in src/store.ts. OWNER: ui-builder.
import { create } from 'zustand'
import type { TaskStatus } from '../data/types'
import { useOffice } from '../store'

export type Tab = 'kanban' | 'list' | 'team'
export type SortKey = 'key' | 'title' | 'status' | 'priority' | 'assignee' | 'due' | 'estimate'

const DISMISS_KEY = 'office.dismissedSuggestions'

function loadDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISS_KEY)
    const v: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

interface UiState {
  dismissed: string[]
  dismissSuggestion: (id: string) => void
  tab: Tab
  setTab: (t: Tab) => void
  panelOpen: boolean
  setPanelOpen: (on: boolean) => void
  wide: boolean
  setWide: (on: boolean) => void
  feedOpen: boolean
  setFeedOpen: (on: boolean) => void
  collapsed: Partial<Record<TaskStatus, boolean>>
  toggleCollapsed: (s: TaskStatus) => void
  sort: { key: SortKey; dir: 'asc' | 'desc' }
  setSort: (key: SortKey) => void
}

export const useUi = create<UiState>((set, get) => ({
  dismissed: loadDismissed(),
  dismissSuggestion: (id) => {
    if (get().dismissed.includes(id)) return
    const dismissed = [...get().dismissed, id].slice(-200)
    set({ dismissed })
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify(dismissed))
    } catch {
      /* storage unavailable: the dismissal lasts for this session only */
    }
  },
  tab: 'kanban',
  setTab: (tab) => {
    if (tab !== 'team') useOffice.getState().setPanelView(tab)
    set({ tab })
  },
  panelOpen: true,
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  wide: false,
  setWide: (wide) => set({ wide }),
  feedOpen: false,
  setFeedOpen: (feedOpen) => set({ feedOpen }),
  collapsed: { done: true },
  toggleCollapsed: (s) => set({ collapsed: { ...get().collapsed, [s]: !get().collapsed[s] } }),
  sort: { key: 'priority', dir: 'desc' },
  setSort: (key) => {
    const { sort } = get()
    set({ sort: sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'priority' ? 'desc' : 'asc' } })
  },
}))
