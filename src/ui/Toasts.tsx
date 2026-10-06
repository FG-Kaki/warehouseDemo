// Toast stack (rendered under the top bar, centered over the 3D view). OWNER: ui-builder.
import { useEffect, useRef } from 'react'
import { useOffice } from '../store'
import { Icon, type IconName } from './icons'

const ICON: Record<'info' | 'good' | 'warn' | 'bad', IconName> = { info: 'spark', good: 'check', warn: 'alert', bad: 'alert' }

export function Toasts() {
  const toasts = useOffice((s) => s.toasts)
  if (toasts.length === 0) return null
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.level}`}>
          <Icon name={ICON[t.level]} size={15} />
          <span>{t.text}</span>
          <button type="button" className="toast-x" aria-label="닫기" onClick={() => useOffice.getState().dismissToast(t.id)}>
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}

/** Connection state for server-backed sources (null for the local mock = render nothing). */
export function ConnectionBanner() {
  const conn = useOffice((s) => s.connection)
  const everOnline = useRef(false)
  const prev = useRef(conn)
  const wasOnline = everOnline.current

  useEffect(() => {
    if (conn === 'online') {
      if (everOnline.current && prev.current !== 'online') useOffice.getState().toast('good', '다시 연결됐어요')
      everOnline.current = true
    }
    prev.current = conn
  }, [conn])

  if (conn === 'offline') {
    return (
      <div className="conn conn-bad" role="status">
        <span className="spinner spinner-sm" />
        서버에 연결할 수 없어요 · 다시 연결하는 중…
      </div>
    )
  }
  if (conn === 'connecting' && wasOnline) {
    return (
      <div className="conn conn-warn" role="status">
        <span className="spinner spinner-sm" />
        다시 연결하는 중…
      </div>
    )
  }
  return null
}
