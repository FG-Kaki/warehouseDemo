// OWNER: architect. Composition root: data source wiring, canvas, HUD, global drag end.
import { Canvas } from '@react-three/fiber'
import { useEffect } from 'react'
import { useOffice } from './store'
import { createMockDataSource } from './data/mock'
import { OfficeScene } from './scene/OfficeScene'
import { Hud } from './ui/Hud'

// One source per page load (module scope, so StrictMode's double effects don't create two).
// Swap this line for an API-backed DataSource later.
const dataSource = createMockDataSource()

export default function App() {
  useEffect(() => {
    void useOffice.getState().init(dataSource)
  }, [])

  useEffect(() => {
    // A drag can start in the 3D view or the panel and end anywhere.
    const up = () => {
      if (useOffice.getState().drag) useOffice.getState().endDrag()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && useOffice.getState().drag) useOffice.getState().cancelDrag()
    }
    window.addEventListener('pointerup', up)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerup', up)
      window.removeEventListener('keydown', key)
    }
  }, [])

  return (
    <div className="app">
      <Canvas shadows dpr={[1, 2]} camera={{ position: [13, 22, 30], fov: 35, near: 0.1, far: 300 }}>
        <OfficeScene />
      </Canvas>
      <Hud />
    </div>
  )
}
