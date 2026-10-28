// 12. Touch (1024x768, touch screen, no mobile emulation): a long press on a kanban card picks it up and a move to a
// column changes its status; a quick swipe scrolls the list instead of dragging.
// Touch is driven with CDP Input.dispatchTouchEvent (Playwright only offers taps); the 300 ms long-press timer is the
// app's own, so we wait for store.drag instead of sleeping.
import type { CDPSession, Locator, Page } from '@playwright/test'
import { expect, openApp, readStore, seedTask, serverTask, taskByTitle, test } from './fixtures'

test.use({ hasTouch: true, isMobile: false, viewport: { width: 1024, height: 768 } })

type Pt = { x: number; y: number }
const touch = (cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', p?: Pt) =>
  cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x: Math.round(p.x), y: Math.round(p.y), id: 1 }] : [] })

async function center(loc: Locator): Promise<Pt> {
  await loc.scrollIntoViewIfNeeded()
  const b = await loc.boundingBox()
  if (!b) throw new Error('no box')
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

async function openDrawer(page: Page) {
  await page.getByRole('button', { name: '관리 패널', exact: true }).tap()
  await expect(page.getByRole('region', { name: '관리 패널' })).toBeVisible()
}

test('long-press a card, move to a column: the status changes', async ({ page, context, source, api }) => {
  await openApp(page, source, { scene: false })
  const task = await seedTask(page, { title: 'E2E 터치 이동', status: 'todo' })
  await openDrawer(page)
  await page.getByRole('searchbox').fill('E2E 터치 이동')
  const drawer = page.getByRole('region', { name: '관리 패널' })
  const column = (label: string) => drawer.locator('.col').filter({ has: page.getByRole('button', { name: new RegExp(`^${label}`) }) })
  const card = column('할 일').getByRole('button', { name: /E2E 터치 이동/ })
  await expect(card).toBeVisible()
  const target = column('진행 중')

  const cdp = await context.newCDPSession(page)
  const from = await center(card)
  await touch(cdp, 'touchStart', from)
  await expect.poll(() => readStore(page, (s) => s.drag?.taskId ?? null), { message: 'long press picks the card up' }).toBe(task.id)
  const to = await center(target)
  for (let i = 1; i <= 8; i++) await touch(cdp, 'touchMove', { x: from.x + ((to.x - from.x) * i) / 8, y: from.y + ((to.y - from.y) * i) / 8 })
  await expect.poll(() => readStore(page, (s) => JSON.stringify(s.dropTarget))).toBe(JSON.stringify({ kind: 'status', status: 'in_progress' }))
  await touch(cdp, 'touchEnd')
  await expect.poll(() => readStore(page, (s) => s.drag)).toBeNull()

  await expect.poll(async () => (await taskByTitle(page, 'E2E 터치 이동')).status).toBe('in_progress')
  if (source === 'api') await expect.poll(async () => (await serverTask(api, task.id))?.status).toBe('in_progress')
})

test('a quick swipe on a card scrolls the list and does not drag', async ({ page, context, source }) => {
  await openApp(page, source, { scene: false })
  await openDrawer(page)
  const drawer = page.getByRole('region', { name: '관리 패널' })
  const body = drawer.locator('.panel-body')
  const card = drawer.getByRole('button', { name: /WEB-31/ }).first()
  await expect(card).toBeVisible()
  const before = await task31(page)
  const scrollBefore = await body.evaluate((el) => el.scrollTop)

  const cdp = await context.newCDPSession(page)
  const from = await center(card)
  await touch(cdp, 'touchStart', from)
  for (let i = 1; i <= 6; i++) await touch(cdp, 'touchMove', { x: from.x, y: from.y - i * 30 })
  expect(await readStore(page, (s) => s.drag), 'no drag during a swipe').toBeNull()
  await touch(cdp, 'touchEnd')

  await expect.poll(() => body.evaluate((el) => el.scrollTop), { message: 'the list scrolled' }).toBeGreaterThan(scrollBefore)
  expect(await readStore(page, (s) => s.drag)).toBeNull()
  expect(await task31(page)).toEqual(before)
})

function task31(page: Page) {
  return readStore(page, (s) => {
    const t = Object.values(s.tasks).find((x) => (x as { number: number }).number === 31) as { status: string; assigneeId: string | null }
    return { status: t.status, assigneeId: t.assigneeId }
  })
}
