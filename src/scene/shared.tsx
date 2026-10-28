// Shared geometries, cached materials and tiny building-block components.
import { Html } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from 'react'
import { BoxGeometry, Color, CylinderGeometry, MeshStandardMaterial, SphereGeometry, type Group as ThreeGroup, type Mesh, type Object3D } from 'three'
import { DYN_LAYER, noRaycast } from './runtime'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'

export const UNIT_BOX = new BoxGeometry(1, 1, 1)
export const UNIT_CYL = new CylinderGeometry(1, 1, 1, 24)
export const UNIT_SPHERE = new SphereGeometry(1, 24, 16)

const matCache = new Map<string, MeshStandardMaterial>()

/** Cached standard material by color (+ optional look). Never dispose these. */
export function stdMat(color: string, rough = 0.8): MeshStandardMaterial {
  const key = `${color}|${rough}`
  let m = matCache.get(key)
  if (!m) {
    m = new MeshStandardMaterial({ color: new Color(color), roughness: rough, metalness: 0 })
    matCache.set(key, m)
  }
  return m
}

const roundedCache = new Map<string, RoundedBoxGeometry>()

/** Cached rounded box of an exact size (so corner radii stay uniform). */
export function roundedGeo(w: number, h: number, d: number, r: number): RoundedBoxGeometry {
  const rr = Math.min(r, Math.min(w, h, d) / 2.2)
  const key = [w, h, d, rr].map((n) => n.toFixed(3)).join('|')
  let g = roundedCache.get(key)
  if (!g) {
    g = new RoundedBoxGeometry(w, h, d, 3, rr)
    roundedCache.set(key, g)
  }
  return g
}

type V3 = [number, number, number]

interface BlockProps {
  p: V3
  s: V3
  c?: string
  mat?: MeshStandardMaterial
  r?: V3
  cast?: boolean
  receive?: boolean
}

/** A sharp box with center `p` and full size `s`. */
export function Block({ p, s, c, mat, r, cast = true, receive = true }: BlockProps) {
  return (
    <mesh
      position={p}
      scale={s}
      rotation={r}
      geometry={UNIT_BOX}
      material={mat ?? stdMat(c ?? '#ffffff')}
      castShadow={cast}
      receiveShadow={receive}
    />
  )
}

/** A rounded box with center `p` and full size `s`; `round` = corner radius. */
export function RBlock({ p, s, c, mat, r, round = 0.05, cast = true, receive = true }: BlockProps & { round?: number }) {
  return (
    <mesh
      position={p}
      rotation={r}
      geometry={roundedGeo(s[0], s[1], s[2], round)}
      material={mat ?? stdMat(c ?? '#ffffff')}
      castShadow={cast}
      receiveShadow={receive}
    />
  )
}

/** Upright cylinder with center `p`. */
export function Cyl({ p, rh, c, cast = true }: { p: V3; rh: [number, number]; c: string; cast?: boolean }) {
  return (
    <mesh position={p} scale={[rh[0], rh[1], rh[0]]} geometry={UNIT_CYL} material={stdMat(c)} castShadow={cast} receiveShadow />
  )
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** Lighten a hex color toward white (0..1). */
export function tint(hex: string, amount: number): string {
  return '#' + new Color(hex).lerp(new Color('#ffffff'), amount).getHexString()
}

/**
 * Marks a static subtree as not pickable (raycast disabled; still rendered and shadow-casting), so pointer
 * raycasts only test boxes/avatars and the ground — cheaper, and furniture never occludes a click.
 * Only covers meshes present at render; meshes that mount later (highlights, discs) set `raycast={noRaycast}` themselves.
 */
export function NoPick({ children }: { children: ReactNode }) {
  const ref = useRef<ThreeGroup>(null)
  useLayoutEffect(() => {
    ref.current?.traverse((o) => {
      if ((o as Mesh).isMesh) o.raycast = noRaycast
    })
  })
  return <group ref={ref}>{children}</group>
}

/**
 * drei <Html> that waits for R3F's event system to be connected. Mounting Html earlier makes drei re-target its
 * portal mid-render ("synchronously unmount a root while React was already rendering").
 */
export function SceneHtml(props: ComponentProps<typeof Html>) {
  const connected = useThree((s) => !!s.events.connected)
  // Mount one animation frame after the event system connects, never inside the commit that connected it.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (!connected) return
    const id = requestAnimationFrame(() => setReady(true))
    return () => cancelAnimationFrame(id)
  }, [connected])
  if (!connected || !ready) return null
  // drei only honours `pointerEvents` in transform mode; without this the label div swallows clicks/drags aimed at the
  // box or bot under it (a hovered box's own tooltip used to block pressing it).
  const style = props.pointerEvents === 'none' ? { pointerEvents: 'none' as const, ...props.style } : props.style
  return <Html {...props} style={style} />
}

/** Puts a dynamic subtree on the dynamic layer (re-applied on every render so late-mounted children are covered). */
export function useDynamicLayer(ref: RefObject<Object3D | null>) {
  useLayoutEffect(() => {
    ref.current?.traverse((o) => o.layers.set(DYN_LAYER))
  })
}
