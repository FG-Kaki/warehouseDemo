# 3D 팀 오피스 대시보드 (folder: warehouse-sim)

A team lead's task/people management tool presented as a living 3D office
(Vite + React 19 + three.js via react-three-fiber/drei + zustand).
Plan: `docs/PLAN.md`. Conventions, data flow and art direction: `.claude/skills/warehouse-sim/SKILL.md`
— load it before touching `src/`.

## Working agreement

- Plan with the user first; implement only after they agree to the plan.

## Team & model allocation

The main session is the **architect** (Opus): it owns the contract files, splits work, integrates,
and makes the final call. It delegates:

| Agent | Model | Does |
|---|---|---|
| `scaffolder` | Haiku | installs, typecheck/build runs, mechanical chores |
| `data-engineer` | Sonnet | `src/data/mock/`, `src/data/api/` (DataSource impls), `tests/contract/` |
| `backend-engineer` | Sonnet | `server/` (Hono + node:sqlite API, SSE, demo bot) per `docs/API.md` |
| `scene-builder` | Sonnet | `src/scene/` 3D office |
| `ui-builder` | Sonnet | `src/ui/` panels, forms, HUD |
| `qa-engineer` | Sonnet | `tests/e2e/` Playwright browser tests (installed Chrome, no browser downloads) |
| `reviewer` | Opus | read-only adversarial review before a feature is accepted |

Rules:
- Contract files (listed in the skill) change only in the main session. Change the contract first, then fan out.
- Builders run in parallel only when their folders don't overlap.
- Every feature goes through `reviewer` before it's called done; fixes go back to the owning builder.

## Commands

- `npm run dev` — dev server (http://localhost:5173); add `?source=api` to use the local API server
- `npm run server` — local API server (http://localhost:8787, contract in `docs/API.md`)
- `npx tsc -b` — typecheck
- `npm run build` — production build (postbuild checks the 3D engine stays out of the first load)
- `npm run test:contract` — DataSource contract suite (mock + API)
- `npm run test:e2e` — browser tests (Playwright, installed Chrome)
