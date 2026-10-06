---
name: warehouse-sim
description: Conventions for this project — a game-like 3D team-office management dashboard (Vite + React 19 + three.js via react-three-fiber/drei + zustand). Load before writing or reviewing any code under src/. Covers the plan, file ownership, the DataSource/store contract, office coordinates, art direction, Korean UI copy and the definition of done. (The folder is still named warehouse-sim for historical reasons.)
---

# 3D 팀 오피스 대시보드 — conventions

Read `docs/PLAN.md` for the product plan. In one line: a team lead manages tasks and people in a
**real management tool** (CRUD, assign, filter) that is presented as a **living 3D office** —
interactive and fun like a web game, not a wall of numbers.

## Data flow (do not deviate)

```
DataSource (src/data/DataSource.ts)  ←—  MockDataSource today, ApiDataSource later
   │ load() / mutations / subscribe(change)
   ▼
store.ts (zustand `useOffice`)  — entities by id + view state + actions
   │                           (optimistic update → source call → reconcile/rollback + toast)
   ├──► scene/  (3D office, reads store, calls store actions)
   └──► ui/     (panels/forms, reads store, calls store actions)
```

- Components **never** import a DataSource. They call store actions (`createTask`, `updateTask`,
  `assignTask`, `moveTask`, `deleteTask`, `createMember`, `updateMember`, `deleteMember`, …).
- Derived data comes from `src/data/selectors.ts` (`tasksOf`, `backlogTasks`, `workload`,
  `matchesFilters`, `computeKpis`, `deadlineRisk`…). Don't re-implement these.
- Subscribe to narrow slices: `useOffice(s => s.tasks)`, `useOffice(s => s.selection)`. Use
  `useShallow` from `zustand/react/shallow` when selecting several fields. Memoize derived lists.
- Per-frame animation (walking, bobbing, flying boxes) lives in `useFrame` + refs. **Never** call
  store setters inside `useFrame`.
- Selection and hover are shared: hovering/selecting in 3D highlights in the panel and vice versa
  (`hover`, `selection`). Filters dim non-matching tasks in 3D too.
- Drag & drop: `startDrag(taskId, from)` on pointerdown-and-move; whoever is under the pointer calls
  `setDropTarget(...)` (scene: desks/avatars → member, backlog shelf → backlog; panel: kanban column →
  status, member row → member). App.tsx calls `endDrag()` on any pointerup and `cancelDrag()` on Esc.
- Camera fly-to: `focusOn({kind,id})`; the scene resolves the position and calls `clearFocus()`.

## Contract files (architect-owned — import, don't edit)

`docs/PLAN.md`, `src/data/types.ts`, `src/data/DataSource.ts`, `src/data/meta.ts`,
`src/data/selectors.ts`, `src/data/insights.ts`, `src/office/layout.ts`, `src/theme.ts`, `src/store.ts`, `src/App.tsx`,
`src/main.tsx`, `src/index.css`.
Need a change? Stop and describe exactly what and why in your report instead of editing.

## File ownership

| Area | Owner | Files |
|---|---|---|
| Mock data + demo mode | data-engineer | `src/data/mock/**` (entry: `createMockDataSource()` in `index.ts`) |
| 3D office | scene-builder | `src/scene/**` (entry: `OfficeScene`) |
| Panels, forms, HUD | ui-builder | `src/ui/**` (entry: `Hud`, styles in `src/ui/*.css`) |

Stay inside your folder.

## Office coordinates

- 1 world unit = 1 meter. x → east, z → south, y up. Floor: `OFFICE.width × OFFICE.depth` from
  `src/office/layout.ts`, origin at the north-west corner.
- Desks: `OFFICE.desks` (id, center x/z, `facing`, pod). The person sits on the side opposite to
  `facing` and looks toward `facing` (radians around +Y, 0 = +z). Member ↔ desk via `member.deskId`.
- Areas: `meetingRoom`, `lounge`, `backlogShelf`, `doneShelf`, `entrance` (x, z = north-west corner,
  w along x, d along z).
- Presence → where the avatar goes: working → own chair, meeting → a spot in the meeting room,
  break → the lounge, away → avatar hidden/ghosted with an empty chair.

## Art direction — minimal & clean

The reference is a clean product render, not a toy box. When in doubt, remove.

- **Space is neutral, data is colorful.** Floor, walls and furniture are white / near-white /
  one light gray family (`PALETTE`). The only structural accent is `PALETTE.accent`, used sparingly.
  Color appears only where it carries meaning: priority/status/workload (`src/data/meta.ts`),
  member color, project color.
- **Simple forms.** Rounded boxes and capsules, few parts per object, no small decorative detail.
  Avatars are little cube bots: one rounded cube in the member color with a dark "screen" face
  strip and two light eye dots — no human features. A slowly spinning status diamond floats above
  each one (color from `SIGNAL_META` in `src/data/insights.ts`).
  Furniture is blocky and rounded (desk = top + 2 slab legs, chair = a rounded block).
  At most a handful of decorative props in the whole office.
- **Quiet labels.** No always-on text in 3D. Names/labels appear on hover or selection only
  (drei `Html`, never drei `Text`).
- **Soft light.** Bright ambient, one soft directional light, soft contact shadows; gentle tone
  mapping. No harsh shadows, no fog color casts.
- **Calm motion.** Avatars glide (slight bob) between places, boxes arc smoothly when they change
  place, hover lifts slightly. Overdue = slow subtle pulse, overload = slight tilt, never jitter.
- **Camera.** Near-isometric (narrow FOV), the office framed inside the screen area not covered by
  HUD panels (`viewInsets` in the store).
- **UI.** Few, consistent elements: white glass panels (`--panel`, `backdrop-filter: blur`), 14px
  radius, soft shadow, generous spacing, one accent color, hairline separators instead of boxes
  inside boxes, inline-SVG icons. Prefer fewer chips and less text; secondary info on hover.
- No textures, external models or network assets.

## Copy

All player-facing text is **Korean**, short and friendly ("작업을 배정했어요", "김하늘 님이 합류했어요").
Code, identifiers and comments are English.

## TypeScript

Strict project settings: `verbatimModuleSyntax` (use `import type`), `erasableSyntaxOnly` (no
`enum`, no parameter properties, no namespaces), `noUnusedLocals/Parameters`.

## Definition of done

1. `npx tsc -b` passes (from the project root).
2. `npm run build` passes.
3. No dev server left running. No new dependencies unless your brief allows it.
4. Report: files changed, anything you needed from a contract file, known gaps.
