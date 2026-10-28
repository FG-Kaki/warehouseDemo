// 5. Drag a 3D task box onto another member's desk / bot (real mouse, targets found through the scene's camera).
import { dragBox, expect, openApp, pickUpBoxOver, seedTask, serverTask, taskByTitle, test } from './fixtures'

test('dragging a 3D box onto a desk and then onto another bot assigns it', async ({ page, source, api }) => {
  await openApp(page, source)
  const task = await seedTask(page, { title: 'E2E 3D 배정', status: 'todo', estimate: 5 })
  expect(task.assigneeId).toBeNull()

  // Backlog shelf -> 정유진 (m_5).
  await dragBox(page, task.id, { kind: 'member', id: 'm_5' }, { kind: 'member', id: 'm_5' })
  await expect.poll(async () => (await taskByTitle(page, 'E2E 3D 배정')).assigneeId).toBe('m_5')
  if (source === 'api') await expect.poll(async () => (await serverTask(api, task.id))?.assigneeId).toBe('m_5')

  // Her stack -> 김하늘 (m_1): the box flies there and can be picked up again from the desk.
  await dragBox(page, task.id, { kind: 'member', id: 'm_1' }, { kind: 'member', id: 'm_1' })
  await expect.poll(async () => (await taskByTitle(page, 'E2E 3D 배정')).assigneeId).toBe('m_1')
  if (source === 'api') await expect.poll(async () => (await serverTask(api, task.id))?.assigneeId).toBe('m_1')

  // Escape cancels a drag: nothing changes.
  await pickUpBoxOver(page, task.id, { kind: 'member', id: 'm_4' }, { kind: 'member', id: 'm_4' })
  await page.keyboard.press('Escape')
  await page.mouse.up()
  expect((await taskByTitle(page, 'E2E 3D 배정')).assigneeId).toBe('m_1')
})
