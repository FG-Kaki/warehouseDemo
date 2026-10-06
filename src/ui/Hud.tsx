// OWNER: ui-builder. Root of all DOM UI layered over the canvas.
// Layout: top bar + overlay switch (top-left), management rail (right), activity feed (bottom-left).
// The center stays free for the 3D office; the root ignores pointer events, panels re-enable them.
import { useEffect, useRef } from 'react'
import { useOffice } from '../store'
import './hud.css'
import './panel.css'
import './dialogs.css'
import { ActivityFeed } from './ActivityFeed'
import { Dialogs } from './Dialogs'
import { DragGhost, useTrackPointer } from './DragGhost'
import { Rail } from './RightPanel'
import { TopBar } from './TopBar'
import { useHotkeys } from './useHotkeys'
import { useUi } from './uiState'

/** Report the screen area covered by HUD panels so the 3D view can frame the office in the rest. */
function useViewInsets(root: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = root.current
    if (!el) return
    let timer = 0
    const measure = () => {
      const rail = el.querySelector<HTMLElement>('.rail')
      const head = el.querySelector<HTMLElement>('.top-head')
      const hasPanel = !!el.querySelector('.rail > .panel, .rail > .detail')
      const right = rail && hasPanel ? Math.round(rail.getBoundingClientRect().width + 12) : 0
      // top: top bar + overlay pill. left stays 0: suggestion cards float over the scene.
      const top = head ? Math.round(head.getBoundingClientRect().bottom + 8) : 0
      useOffice.getState().setViewInsets({ top, right, bottom: 0, left: 0 })
    }
    // Debounced so width transitions settle before the scene re-frames.
    const schedule = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(measure, 120)
    }
    measure()
    const ro = new ResizeObserver(schedule)
    const mo = new MutationObserver(schedule)
    const watch = () => {
      ro.disconnect()
      for (const sel of ['.rail', '.top-head']) {
        const n = el.querySelector(sel)
        if (n) ro.observe(n)
      }
    }
    watch()
    const rail = el.querySelector('.rail')
    if (rail) mo.observe(rail, { childList: true })
    window.addEventListener('resize', schedule)
    return () => {
      window.clearTimeout(timer)
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener('resize', schedule)
    }
  }, [root])
}

export function Hud() {
  const root = useRef<HTMLDivElement>(null)
  useViewInsets(root)
  useHotkeys()
  useTrackPointer()
  const status = useOffice((s) => s.status)
  const dragging = useOffice((s) => s.drag !== null)
  const hasDetail = useOffice((s) => {
    if (!s.selection) return false
    return s.selection.kind === 'task' ? !!s.tasks[s.selection.id] : !!s.members[s.selection.id]
  })
  const panelOpen = useUi((s) => s.panelOpen)
  const wide = useUi((s) => s.wide)

  const railMode = panelOpen ? (wide ? 'rail-wide' : 'rail-normal') : hasDetail ? 'rail-normal' : 'rail-min'

  return (
    <div ref={root} className={`hud ${railMode}${dragging ? ' is-dragging' : ''}`}>
      <TopBar />
      <ActivityFeed />
      <Rail />
      <Dialogs />
      <DragGhost />
      {(status === 'loading' || status === 'idle') && (
        <div className="loader" role="status">
          <span className="spinner" />
          <span>사무실을 여는 중…</span>
        </div>
      )}
    </div>
  )
}
