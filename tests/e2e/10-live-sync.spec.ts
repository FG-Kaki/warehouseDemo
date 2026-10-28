// 10. (api only) Two browser contexts on the same server: a change in one shows up live in the other.
import { callStore, expect, openApp, panel, readStore, seedTask, taskByTitle, taskCard, test } from './fixtures'

test.skip(({ source }) => source !== 'api', 'api source only')

test('a change made in one tab appears live in the other', async ({ page, browser, source, baseURL }) => {
  const other = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } })
  try {
    const pageB = await other.newPage()
    await openApp(page, source, { scene: false })
    await openApp(pageB, source, { scene: false })

    // Create in A -> card in B.
    const task = await seedTask(page, { title: 'E2E 실시간 작업', status: 'todo' })
    await expect(taskCard(pageB, 'E2E 실시간 작업')).toBeVisible()

    // Move + assign in B -> reflected in A's store and kanban.
    await callStore(pageB, 'moveTask', task.id, 'review')
    await callStore(pageB, 'assignTask', task.id, 'm_4')
    await expect.poll(async () => (await taskByTitle(page, 'E2E 실시간 작업')).status).toBe('review')
    await expect.poll(async () => (await taskByTitle(page, 'E2E 실시간 작업')).assigneeId).toBe('m_4')
    const review = panel(page).locator('.col').filter({ has: page.getByRole('button', { name: /^검토/ }) })
    await expect(review.getByRole('button', { name: /E2E 실시간 작업/ })).toBeVisible()

    // Delete in A -> gone in B.
    await callStore(page, 'deleteTask', task.id)
    await expect(taskCard(pageB, 'E2E 실시간 작업')).toHaveCount(0)
    expect(await readStore(pageB, (s) => (Object.values(s.tasks) as { id: string }[]).some((t) => t.id === task.id))).toBe(false)
  } finally {
    await other.close()
  }
})
