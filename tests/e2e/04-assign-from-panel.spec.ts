// 4. Assigning across the panel / 3D boundary.
// Task cards live in the kanban tab and member cards in the team tab, so a card can't be dragged onto a member
// card inside the panel itself. The two real ways to assign across surfaces are tested instead:
//   a) kanban card  ->  a member's desk/bot in the 3D office
//   b) 3D task box  ->  a member card in the team tab (and back to the backlog strip)
import { expect, moveToDropTarget, openApp, panel, pickUpBoxOverElement, readStore, seedTask, serverTask, tab, taskByTitle, test } from './fixtures'

const MEMBER = 'm_5' // 정유진 works at her desk, so her bot is in the scene

test('dragging a kanban card onto a member in the 3D view assigns the task', async ({ page, source, api }) => {
  await openApp(page, source)
  const task = await seedTask(page, { title: 'E2E 책상 배정', status: 'todo' })
  expect(task.assigneeId).toBeNull()

  await page.getByRole('searchbox').fill('E2E 책상 배정')
  const card = panel(page).getByRole('button', { name: /E2E 책상 배정/ })
  await expect(card).toBeVisible()
  const box = await card.boundingBox()
  if (!box) throw new Error('card has no box')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2

  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 8, y + 8)
  await expect.poll(() => readStore(page, (s) => s.drag?.from ?? null)).toBe('panel')
  await moveToDropTarget(page, { kind: 'member', id: MEMBER }, { kind: 'member', id: MEMBER })
  await page.mouse.up()
  await expect.poll(() => readStore(page, (s) => s.drag)).toBeNull()

  await expect.poll(async () => (await taskByTitle(page, 'E2E 책상 배정')).assigneeId).toBe(MEMBER)
  if (source === 'api') await expect.poll(async () => (await serverTask(api, task.id))?.assigneeId).toBe(MEMBER)
})

test('dragging a 3D box onto a member card in the team tab assigns the task', async ({ page, source, api }) => {
  await openApp(page, source)
  const task = await seedTask(page, { title: 'E2E 팀 탭 배정', status: 'todo' })
  await tab(page, '팀원').click()
  const memberCard = panel(page).getByRole('button', { name: /정유진/ })
  await expect(memberCard).toBeVisible()

  await pickUpBoxOverElement(page, task.id, memberCard, { kind: 'member', id: MEMBER })
  await page.mouse.up()
  await expect.poll(async () => (await taskByTitle(page, 'E2E 팀 탭 배정')).assigneeId).toBe(MEMBER)
  if (source === 'api') await expect.poll(async () => (await serverTask(api, task.id))?.assigneeId).toBe(MEMBER)

  // And back to the backlog by dropping on the backlog strip at the top of the team tab.
  await pickUpBoxOverElement(page, task.id, panel(page).getByText(/^백로그/), { kind: 'backlog' })
  await page.mouse.up()
  await expect.poll(async () => (await taskByTitle(page, 'E2E 팀 탭 배정')).assigneeId).toBeNull()
  if (source === 'api') await expect.poll(async () => (await serverTask(api, task.id))?.assigneeId).toBeNull()
})
