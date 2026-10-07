// Runs after `npm run build`. Fails if the first page load pulls in the 3D engine: three.js and
// react-three must only load with the lazy 3D view (src/app/SceneCanvas.tsx), never from index.html.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const dist = new URL('../dist/', import.meta.url)
const html = readFileSync(new URL('index.html', dist), 'utf8')
const initial = [...html.matchAll(/(?:src|href)="\/?(assets\/[^"]+\.js)"/g)].map((m) => m[1])

const banned = initial.filter((f) => /assets\/(three|r3f)-/.test(f))
const kb = (f) => Math.round(statSync(join(dist.pathname.replace(/^\/([A-Za-z]:)/, '$1'), f)).size / 1024)
const total = initial.reduce((s, f) => s + kb(f), 0)

console.log(`initial JS: ${initial.map((f) => `${f.replace('assets/', '')} ${kb(f)} kB`).join(', ')} = ${total} kB`)
const lazy = readdirSync(new URL('assets/', dist)).filter((f) => /^(three|r3f|SceneCanvas)-.*\.js$/.test(f))
console.log(`lazy 3D: ${lazy.join(', ')}`)

if (banned.length) {
  console.error(`✗ index.html loads 3D chunks eagerly: ${banned.join(', ')} — check build.rolldownOptions codeSplitting groups in vite.config.ts`)
  process.exit(1)
}
