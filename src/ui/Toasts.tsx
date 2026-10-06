// Toast stack (rendered under the top bar, centered over the 3D view). OWNER: ui-builder.
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
