// OWNER: ui-builder. Root of all DOM UI layered over the canvas.
// Layout: top bar + overlay switch (top-left), management rail (right), activity feed (bottom-left).
// The center stays free for the 3D office; the root ignores pointer events, panels re-enable them.
import { useEffect, useRef } from 'react'
import { useOffice } from '../store'
import './hud.css'
import './panel.css'
import './dialogs.css'
import './meeting.css'
import './responsive.css'
import { ActivityFeed } from './ActivityFeed'
import { Dialogs } from './Dialogs'
import { DragGhost, useTrackPointer } from './DragGhost'
import { OVERLAY_QUERY, useMediaQuery, useTouchDragGuard } from './hooks'
import { Rail } from './RightPanel'
import { Toasts } from './Toasts'
import { TopBar } from './TopBar'
import { useHotkeys } from './useHotkeys'
import { useUi } from './uiState'

/** Report the screen area covered by HUD panels so the 3D view can frame the office in the rest. */
function useViewInsets(root: React.RefObject<HTMLDivElement | null>, overlay: boolean) {
  useEffect(() => {
    const el = root.current
    if (!el) return
    let timer = 0
    const measure = () => {
      const rail = el.querySelector<HTMLElement>('.rail')
      const head = el.querySelector<HTMLElement>('.top-head')
      const hasPanel = !!el.querySelector('.rail > .panel, .rail > .detail')
      // An overlay drawer floats over the scene and reserves nothing, so the 3D view doesn't jump.
      const right = !overlay && rail && hasPanel ? Math.round(rail.getBoundingClientRect().width + 12) : 0
      // top: top bar + overlay pill. left stays 0: suggestion cards float over the scene.
      const top = head ? Math.round(head.getBoundingClientRect().bottom + 8) : 0
      // The overlay drawer starts just below the top bar so the bar's actions stay reachable.
      const bar = el.querySelector<HTMLElement>('.topbar')
      if (bar) el.style.setProperty('--top-h', `${Math.round(bar.getBoundingClientRect().bottom + 8)}px`)
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
  }, [root, overlay])
}

export function Hud() {
  const root = useRef<HTMLDivElement>(null)
  const overlay = useMediaQuery(OVERLAY_QUERY)
  useViewInsets(root, overlay)
  useHotkeys()
  useTrackPointer()
  useTouchDragGuard()
  const status = useOffice((s) => s.status)
  const offline = useOffice((s) => s.connection === 'offline')
  const dragging = useOffice((s) => s.drag !== null)
  const hasDetail = useOffice((s) => {
    if (!s.selection) return false
    return s.selection.kind === 'task' ? !!s.tasks[s.selection.id] : !!s.members[s.selection.id]
  })
  const panelOpen = useUi((s) => s.panelOpen)
  const wide = useUi((s) => s.wide)

  // Crossing the breakpoint: entering overlay mode collapses the rail but remembers the docked
  // choice; leaving it restores that choice.
  const prevOverlay = useRef(overlay)
  const dockedOpen = useRef(true)
  useEffect(() => {
    if (prevOverlay.current === overlay) return
    prevOverlay.current = overlay
    const ui = useUi.getState()
    if (overlay) {
      dockedOpen.current = ui.panelOpen
      ui.setPanelOpen(false)
    } else {
      ui.setPanelOpen(dockedOpen.current)
    }
  }, [overlay])

  // Overlay drawer: a tap outside closes it (Esc is handled in useHotkeys).
  useEffect(() => {
    if (!overlay || !panelOpen) return
    // Close on a *tap* only: a press that stays put and ends without a drag. A drag that starts in the
    // 3D view (4 px / long-press), an orbit or a pan must leave the drawer open so boxes can be
    // dropped into it.
    let press: { id: number; x: number; y: number; moved: boolean; dragged: boolean } | null = null
    const unsub = useOffice.subscribe((s) => {
      if (press && s.drag) press.dragged = true
    })
    const down = (e: PointerEvent) => {
      const t = e.target
      press = null
      if (!e.isPrimary || !(t instanceof Element) || t.closest('.rail, .modal-backdrop, .toasts, .menu, .ghost')) return
      press = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, dragged: !!useOffice.getState().drag }
    }
    const move = (e: PointerEvent) => {
      if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) press.moved = true
    }
    const up = (e: PointerEvent) => {
      const p = press
      if (!p || e.pointerId !== p.id) return
      press = null
      if (!p.moved && !p.dragged && !useOffice.getState().drag) useUi.getState().setPanelOpen(false)
    }
    const cancel = () => {
      press = null
    }
    window.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    return () => {
      unsub()
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
    }
  }, [overlay, panelOpen])

  const railMode = panelOpen ? (wide ? 'rail-wide' : 'rail-normal') : hasDetail ? 'rail-normal' : 'rail-min'

  return (
    <div ref={root} className={`hud ${railMode}${overlay ? ' is-overlay' : ''}${dragging ? ' is-dragging' : ''}`}>
      <TopBar />
      <div className="hud-bottom">
        <Toasts />
        <ActivityFeed />
      </div>
      <Rail />
      <Dialogs />
      <DragGhost />
      {(status === 'loading' || status === 'idle') && !offline && (
        <div className="loader" role="status">
          <span className="spinner" />
          <span>사무실을 여는 중…</span>
        </div>
      )}
    </div>
  )
}
