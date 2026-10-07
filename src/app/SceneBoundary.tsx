// OWNER: architect. Keeps the management HUD alive when the 3D view can't load or crashes
// (stale chunk after a rebuild, offline, no WebGL). Without it React would unmount the whole app.
import { Component, type ReactNode } from 'react'

interface State {
  failed: boolean
  attempt: number
}

export class SceneBoundary extends Component<{ children: (attempt: number) => ReactNode }, State> {
  state: State = { failed: false, attempt: 0 }

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    console.error('3D view failed', error)
  }

  render() {
    if (!this.state.failed) return this.props.children(this.state.attempt)
    return (
      <div className="scene-failed" role="status">
        <span>3D 화면을 불러오지 못했어요</span>
        <button type="button" onClick={() => this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }))}>
          다시 시도
        </button>
      </div>
    )
  }
}
