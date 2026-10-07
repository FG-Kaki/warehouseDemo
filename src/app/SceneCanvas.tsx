// OWNER: architect. The 3D view, loaded lazily so the HUD and data come up before three.js.
import { Canvas } from '@react-three/fiber'
import { OfficeScene } from '../scene/OfficeScene'

export default function SceneCanvas() {
  return (
    <Canvas shadows dpr={[1, 2]} camera={{ position: [13, 22, 30], fov: 35, near: 0.1, far: 300 }}>
      <OfficeScene />
    </Canvas>
  )
}
