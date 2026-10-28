// 8. Suggestion card: the one-click "넘기기" / "배정하기" really performs the assignment.
import { expect, openApp, seedTask, serverTask, test } from './fixtures'
import type { Page } from '@playwright/test'

interface Sug {
  id: string
  kind: 'reassign' | 'assign'
  taskId: string
  toId: string
  title: string
}

/** What the app would suggest right now (same pure function the UI uses), minus dismissed ones. */
function currentSuggestions(page: Page): Promise<Sug[]> {
  return page.evaluate(async () => {
    const { useOffice } = await import(/* @vite-ignore */ ('/src/store.ts' as string))
    const { suggestActions } = await import(/* @vite-ignore */ ('/src/data/insights.ts' as string))
    const s = useOffice.getState()
    return suggestActions(s.tasks, s.members, 12) as Sug[]
  })
}

test('applying a suggestion from the pill and from the expanded card assigns the task', async ({ page, source, api }) => {
  await openApp(page, source, { scene: false })
  // Overload 이도윤 (m_2: 140% in the seed) a bit more with a not-yet-started task, so a rebalance is on offer.
  await seedTask(page, { title: 'E2E 과부하 작업', assigneeId: 'm_2', estimate: 3, status: 'todo' })

  // ...and an important backlog task, so a plain "배정하기" follows the rebalance.
  await seedTask(page, { title: 'E2E 긴급 미배정', assigneeId: null, estimate: 1, priority: 'urgent', status: 'todo' })

  const suggest = page.getByLabel('추천 액션')
  await expect(suggest).toBeVisible()
  const [first] = await currentSuggestions(page)
  expect(first.kind).toBe('reassign')
  const label = (s: Sug) => (s.kind === 'reassign' ? '넘기기' : '배정하기')

  // 1) The collapsed pill carries the top suggestion with its action button.
  await expect(suggest.getByText(first.title)).toBeVisible()
  await suggest.getByRole('button', { name: label(first), exact: true }).click()
  await expect(page.getByText(/님에게 (넘겼|배정했)어요/).first()).toBeVisible()
  await expect.poll(() => assigneeOf(page, first.taskId)).toBe(first.toId)
  if (source === 'api') await expect.poll(async () => (await serverTask(api, first.taskId))?.assigneeId).toBe(first.toId)

  // 2) Next one from the expanded stack.
  const next = (await currentSuggestions(page))[0]
  expect(next, 'another suggestion is on offer').toBeDefined()
  expect(next.id).not.toBe(first.id)
  await suggest.getByRole('button', { name: '펼치기' }).click()
  const card = suggest.getByRole('group', { name: '추천' }).filter({ hasText: next.title }).first()
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: label(next), exact: true }).click()
  await expect.poll(() => assigneeOf(page, next.taskId)).toBe(next.toId)
  if (source === 'api') await expect.poll(async () => (await serverTask(api, next.taskId))?.assigneeId).toBe(next.toId)
})

test('dismissing a suggestion removes it and keeps the task untouched', async ({ page, source }) => {
  await openApp(page, source, { scene: false })
  const suggest = page.getByLabel('추천 액션')
  await expect(suggest).toBeVisible()
  const [first] = await currentSuggestions(page)
  const before = await assigneeOf(page, first.taskId)
  await suggest.getByRole('button', { name: '펼치기' }).click()
  await suggest.getByRole('group', { name: '추천' }).filter({ hasText: first.title }).first().getByRole('button', { name: '닫기' }).click()
  await expect(suggest.getByText(first.title)).toHaveCount(0)
  expect(await assigneeOf(page, first.taskId)).toBe(before)
})

function assigneeOf(page: Page, taskId: string): Promise<string | null> {
  return page.evaluate(async (id) => {
    const { useOffice } = await import(/* @vite-ignore */ ('/src/store.ts' as string))
    return useOffice.getState().tasks[id]?.assigneeId ?? null
  }, taskId)
}
