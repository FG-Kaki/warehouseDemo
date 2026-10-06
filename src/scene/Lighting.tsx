// Soft "product render" light: bright ambient/hemisphere fill + one big soft-shadow sun, gentle tone mapping.
import { ContactShadows } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { ACESFilmicToneMapping, Color, Object3D, PCFShadowMap } from 'three'
import { OFFICE } from '../office/layout'
import { PALETTE } from '../theme'
import { DYN_LAYER } from './runtime'

// A touch darker and cooler than the floor so the room reads against it.
const BG = '#' + new Color(PALETTE.background).lerp(new Color('#6a7fa8'), 0.5).getHexString()

export function Lighting() {
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera)
  const raycaster = useThree((s) => s.raycaster)
  const cx = OFFICE.width / 2
  const cz = OFFICE.depth / 2
  const target = useMemo(() => {
    const t = new Object3D()
    t.position.set(cx, 0, cz)
    return t
  }, [cx, cz])

  useEffect(() => {
    const prevMap = gl.toneMapping
    const prevExp = gl.toneMappingExposure
    const prevShadow = gl.shadowMap.type
    gl.toneMapping = ACESFilmicToneMapping
    gl.toneMappingExposure = 1.2
    // PCFShadowMap honours `shadow.radius`, which gives the wide soft penumbra.
    gl.shadowMap.type = PCFShadowMap
    return () => {
      gl.toneMapping = prevMap
      gl.toneMappingExposure = prevExp
      gl.shadowMap.type = prevShadow
    }
  }, [gl])

  // Moving things live on DYN_LAYER: the camera, the sun's shadow camera and pointer picking must see it.
  useEffect(() => {
    camera.layers.enable(DYN_LAYER)
    raycaster.layers.enable(DYN_LAYER)
  }, [camera, raycaster])

  return (
    <>
      <color attach="background" args={[BG]} />
      <ambientLight intensity={0.75} color={PALETTE.wall} />
      <hemisphereLight args={[PALETTE.wall, PALETTE.wallTrim, 0.95]} />
      <primitive object={target} />
      <ContactShadows frames={1} position={[cx, 0.015, cz]} scale={[OFFICE.width + 2, OFFICE.depth + 2]} opacity={0.45} blur={2.4} far={2.6} resolution={1024} color={PALETTE.shadow} />
      <directionalLight
        ref={(l) => l?.shadow.camera.layers.enable(DYN_LAYER)}
        position={[cx - 12, 30, cz + 12]}
        target={target}
        intensity={2.2}
        color={PALETTE.wall}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-20}
        shadow-camera-right={20}
        shadow-camera-top={20}
        shadow-camera-bottom={-20}
        shadow-camera-near={1}
        shadow-camera-far={90}
        shadow-bias={-0.0003}
        shadow-normalBias={0.05}
        shadow-radius={9}
      />
    </>
  )
}
