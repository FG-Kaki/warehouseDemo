// 2. Task CRUD through the UI: create (with validation), edit in the detail drawer, delete with confirm.
import { expect, openApp, panel, serverWorkspace, taskByTitle, test } from './fixtures'

test('create, edit and delete a task through the UI', async ({ page, source, api }) => {
  await openApp(page, source, { scene: false })
  const todoColumn = panel(page).locator('.col').filter({ has: page.getByRole('button', { name: /^할 일/ }) })

  // --- create: empty title is rejected ---
  await page.getByRole('button', { name: '작업', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '새 작업' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '만들기' }).click()
  await expect(dialog.getByText('제목을 입력해 주세요')).toBeVisible()
  await expect(dialog).toBeVisible()

  // --- create: valid ---
  await dialog.getByPlaceholder('무엇을 해야 하나요?').fill('E2E 새 작업')
  await dialog.getByRole('button', { name: '만들기' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText('작업을 만들었어요')).toBeVisible()
  const card = todoColumn.getByRole('button', { name: /E2E 새 작업/ })
  await expect(card).toBeVisible()
  const created = await taskByTitle(page, 'E2E 새 작업')
  expect(created.status).toBe('todo')
  expect(created.assigneeId).toBeNull()
  if (source === 'api') expect((await serverWorkspace(api)).tasks.some((t) => t.id === created.id)).toBe(true)

  // --- edit the title in the detail drawer ---
  await card.click()
  const detail = page.getByRole('complementary', { name: '작업 상세' })
  await expect(detail).toBeVisible()
  const title = detail.getByRole('textbox', { name: '제목' })
  await expect(title).toHaveValue('E2E 새 작업')
  await title.fill('E2E 수정된 작업')
  await title.press('Enter')
  await expect(todoColumn.getByRole('button', { name: /E2E 수정된 작업/ })).toBeVisible()
  await expect(todoColumn.getByRole('button', { name: /E2E 새 작업/ })).toHaveCount(0)
  if (source === 'api') {
    await expect.poll(async () => (await serverWorkspace(api)).tasks.find((t) => t.id === created.id)?.title).toBe('E2E 수정된 작업')
  }

  // --- delete: cancel keeps it, confirm removes it ---
  await detail.getByRole('button', { name: '삭제' }).click()
  const confirm = page.getByRole('dialog', { name: '작업을 삭제할까요?' })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: '취소' }).click()
  await expect(confirm).toBeHidden()
  await expect(todoColumn.getByRole('button', { name: /E2E 수정된 작업/ })).toBeVisible()

  await detail.getByRole('button', { name: '삭제' }).click()
  await page.getByRole('dialog', { name: '작업을 삭제할까요?' }).getByRole('button', { name: '삭제' }).click()
  await expect(page.getByText('작업을 삭제했어요')).toBeVisible()
  await expect(todoColumn.getByRole('button', { name: /E2E 수정된 작업/ })).toHaveCount(0)
  await expect(detail).toBeHidden()
  if (source === 'api') {
    await expect.poll(async () => (await serverWorkspace(api)).tasks.some((t) => t.id === created.id)).toBe(false)
  }
})
