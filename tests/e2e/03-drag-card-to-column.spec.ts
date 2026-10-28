// 3. Drag a kanban card to another column: the status changes (real mouse).
import { dragCard, expect, openApp, panel, seedTask, serverTask, taskByTitle, test } from './fixtures'

test('dragging a panel card onto a kanban column changes its status', async ({ page, source, api }) => {
  await openApp(page, source, { scene: false })
  const task = await seedTask(page, { title: 'E2E 칸반 이동', status: 'todo' })

  // Side-by-side columns, and only our card in the list so geometry is stable.
  await panel(page).getByRole('button', { name: '넓게' }).click()
  await page.getByRole('searchbox').fill('E2E 칸반 이동')
  const column = (label: string) => panel(page).locator('.col').filter({ has: page.getByRole('button', { name: new RegExp(`^${label}`) }) })
  const card = column('할 일').getByRole('button', { name: /E2E 칸반 이동/ })
  await expect(card).toBeVisible()

  await dragCard(page, card, column('검토'), { kind: 'status', status: 'review' })

  await expect(column('검토').getByRole('button', { name: /E2E 칸반 이동/ })).toBeVisible()
  await expect(column('할 일').getByRole('button', { name: /E2E 칸반 이동/ })).toHaveCount(0)
  expect((await taskByTitle(page, 'E2E 칸반 이동')).status).toBe('review')
  if (source === 'api') await expect.poll(async () => (await serverTask(api, task.id))?.status).toBe('review')

  // And on to 진행 중, to make sure a second drag works from the new column.
  await dragCard(page, column('검토').getByRole('button', { name: /E2E 칸반 이동/ }), column('진행 중'), { kind: 'status', status: 'in_progress' })
  await expect.poll(async () => (await taskByTitle(page, 'E2E 칸반 이동')).status).toBe('in_progress')
  if (source === 'api') await expect.poll(async () => (await serverTask(api, task.id))?.status).toBe('in_progress')
})
