// 1. Load: HUD, KPIs, the 3D canvas, and a clean console.
import { expect, openApp, readStore, test } from './fixtures'

test('loads the office: HUD, KPI numbers, 3D canvas, no console errors', async ({ page, source }) => {
  await openApp(page, source)

  await expect(page.getByRole('banner').getByText('팀 오피스')).toBeVisible()
  await expect(page.getByRole('tablist').getByRole('tab', { name: /^칸반/ })).toBeVisible()
  await expect(page.getByRole('region', { name: '관리 패널' })).toBeVisible()
  await expect(page.locator('canvas')).toBeVisible()
  const box = await page.locator('canvas').boundingBox()
  expect(box?.width).toBeGreaterThan(800)

  // KPI chips show the numbers computed from the data.
  const expected = await page.evaluate(async () => {
    const storePath = '/src/store.ts'
    const selPath = '/src/data/selectors.ts'
    const { useOffice } = await import(/* @vite-ignore */ storePath)
    const { computeKpis } = await import(/* @vite-ignore */ selPath)
    const s = useOffice.getState()
    return computeKpis(s.tasks, s.members)
  })
  expect(expected.open).toBeGreaterThan(0)
  const kpis = page.locator('.kpis')
  const value = (label: string) => kpis.locator('.kpi', { hasText: label }).locator('.kpi-value')
  await expect(value('진행 중')).toHaveText(String(expected.inProgress))
  await expect(value('지연')).toHaveText(String(expected.overdue))
  await expect(value('미배정')).toHaveText(String(expected.unassigned))
  await expect(value('이번 주 완료')).toHaveText(String(expected.doneThisWeek))

  // The data source matches the project.
  const label = await readStore(page, (s) => s.sourceLabel)
  expect(label).toBe(source === 'api' ? '로컬 서버' : '로컬 데모 데이터')
  if (source === 'api') await expect(page.getByText('서버', { exact: true })).toBeVisible()
  expect(await readStore(page, (s) => Object.keys(s.members).length)).toBe(7)
})
