// Global keyboard shortcuts. OWNER: ui-builder.
//   N new task · / search · 1-4 overlays · Esc close dialog, else clear selection
import { useEffect } from 'react'
import { useOffice, type Overlay } from '../store'
import { useUi } from './uiState'

const OVERLAY_BY_CODE: Record<string, Overlay> = { Digit1: 'none', Digit2: 'workload', Digit3: 'deadline', Digit4: 'project' }

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export function useHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return
      if (isTyping(e.target)) return
      const st = useOffice.getState()

      if (e.key === 'Escape') {
        if (st.drag) return // App cancels the drag
        if (st.dialog) st.openDialog(null)
        else if (st.selection) st.select(null)
        return
      }
      if (st.dialog || st.drag) return

      if (e.code === 'KeyN') {
        e.preventDefault()
        st.openDialog({ kind: 'task' })
      } else if (e.code === 'Slash') {
        e.preventDefault()
        const ui = useUi.getState()
        ui.setPanelOpen(true)
        if (ui.tab === 'team') ui.setTab('kanban')
        requestAnimationFrame(() => {
          const el = document.getElementById('hud-search')
          el?.focus()
          if (el instanceof HTMLInputElement) el.select()
        })
      } else if (e.code in OVERLAY_BY_CODE) {
        st.setOverlay(OVERLAY_BY_CODE[e.code])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
