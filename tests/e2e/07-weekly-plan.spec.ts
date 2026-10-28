// 7. Weekly tab: dragging a chip to another day changes the due date; to another member's row changes the assignee.
import { dragCard, expect, openApp, panel, seedTask, serverTask, tab, taskByTitle, test } from './fixtures'

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
/** Local date of weekday `n` (0 = Monday) of the current week, the same week the grid shows. */
function weekday(n: number): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + n)
  return iso(d)
}

test('dragging a weekly chip changes the due date, and the assignee across rows', async ({ page, source, api }) => {
  await openApp(page, source, { scene: false })
  const task = await seedTask(page, { title: 'E2E 주간 칩', assigneeId: 'm_1', dueDate: weekday(1), estimate: 2 })

  await tab(page, '주간').click()
  const row = (name: string) => panel(page).locator('.wk-row').filter({ hasText: name })
  // Columns of the current week: 0 = 지연, 1..5 = 월..금, 6 = 주말.
  const cell = (name: string, weekdayIndex: number) => row(name).locator('.wk-cell').nth(weekdayIndex + 1)
  const chip = panel(page).getByRole('button', { name: /E2E 주간 칩/ })
  await expect(cell('김하늘', 1).getByRole('button', { name: /E2E 주간 칩/ })).toBeVisible()

  // Tuesday -> Thursday, same person.
  await dragCard(page, chip, cell('김하늘', 3), { kind: 'day', date: weekday(3), memberId: 'm_1' })
  await expect(cell('김하늘', 3).getByRole('button', { name: /E2E 주간 칩/ })).toBeVisible()
  await expect.poll(async () => (await taskByTitle(page, 'E2E 주간 칩')).dueDate).toBe(weekday(3))
  expect((await taskByTitle(page, 'E2E 주간 칩')).assigneeId).toBe('m_1')
  if (source === 'api') await expect.poll(async () => (await serverTask(api, task.id))?.dueDate).toBe(weekday(3))

  // Thursday -> Friday in 정유진's row: due date and assignee change together.
  await dragCard(page, chip, cell('정유진', 4), { kind: 'day', date: weekday(4), memberId: 'm_5' })
  await expect(cell('정유진', 4).getByRole('button', { name: /E2E 주간 칩/ })).toBeVisible()
  await expect.poll(async () => (await taskByTitle(page, 'E2E 주간 칩')).assigneeId).toBe('m_5')
  expect((await taskByTitle(page, 'E2E 주간 칩')).dueDate).toBe(weekday(4))
  if (source === 'api') {
    await expect.poll(async () => (await serverTask(api, task.id))?.assigneeId).toBe('m_5')
    expect((await serverTask(api, task.id))?.dueDate).toBe(weekday(4))
  }

  // Dropping on the cell it is already in changes nothing (an update would be applied optimistically, i.e. at once).
  await page.evaluate(async (id) => {
    const { useOffice } = await import(/* @vite-ignore */ ('/src/store.ts' as string))
    ;(window as unknown as { __updates: number }).__updates = 0
    useOffice.subscribe((s: { tasks: Record<string, unknown> }, p: { tasks: Record<string, unknown> }) => {
      if (s.tasks[id] !== p.tasks[id]) (window as unknown as { __updates: number }).__updates++
    })
  }, task.id)
  await dragCard(page, chip, cell('정유진', 4), { kind: 'day', date: weekday(4), memberId: 'm_5' })
  expect(await page.evaluate(() => (window as unknown as { __updates: number }).__updates)).toBe(0)
})
