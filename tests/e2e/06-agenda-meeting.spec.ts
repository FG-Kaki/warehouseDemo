// 6. Agenda + meeting: drop a box on the meeting table, start a meeting, end it with one assignment, one kept item
// and notes -> store/server state and the 회의록 entry.
import { dragBox, expect, openApp, serverWorkspace, seedTask, taskByTitle, test } from './fixtures'

test('agenda, meeting start and end with outcomes and minutes', async ({ page, source, api }) => {
  await openApp(page, source)
  const task = await seedTask(page, { title: 'E2E 안건 작업', status: 'todo', priority: 'urgent' })

  // The seed already has two agenda tasks; drop a third box on the meeting table.
  const seeded = await page.evaluate(async () => {
    const { useOffice } = await import(/* @vite-ignore */ ('/src/store.ts' as string))
    return (Object.values(useOffice.getState().tasks) as { id: string; title: string; onAgenda: boolean }[]).filter((t) => t.onAgenda).map((t) => t.title)
  })
  expect(seeded).toHaveLength(2)
  await dragBox(page, task.id, { kind: 'agenda' }, { kind: 'agenda' })
  await expect.poll(async () => (await taskByTitle(page, 'E2E 안건 작업')).onAgenda).toBe(true)
  if (source === 'api') await expect.poll(async () => (await serverWorkspace(api)).tasks.find((t) => t.id === task.id)?.onAgenda).toBe(true)
  await expect(page.getByRole('button', { name: /^회의/ }).getByText('3')).toBeVisible()

  // Start the meeting from the top bar.
  await page.getByRole('button', { name: /^회의/ }).click()
  const start = page.getByRole('dialog', { name: '회의 시작' })
  await expect(start.getByText('안건 3개')).toBeVisible()
  await start.getByPlaceholder('예: 주간 싱크').fill('E2E 주간 회의')
  await start.getByRole('button', { name: '회의 시작' }).click()
  await expect(start).toBeHidden()
  const live = page.getByRole('status').filter({ hasText: 'E2E 주간 회의' })
  await expect(live).toBeVisible()
  const ongoing = await page.evaluate(async () => {
    const { useOffice, ongoingMeeting } = await import(/* @vite-ignore */ ('/src/store.ts' as string))
    const m = ongoingMeeting(useOffice.getState().meetings)
    return m && { id: m.id, title: m.title, agenda: m.agendaTaskIds.length, attendees: m.attendeeIds.length }
  })
  expect(ongoing).toMatchObject({ title: 'E2E 주간 회의', agenda: 3 })
  expect(ongoing?.attendees).toBeGreaterThan(0)

  // End it: assign our task to 김하늘, keep the other two, write notes.
  await live.getByRole('button', { name: '회의 종료' }).click()
  const end = page.getByRole('dialog', { name: /^회의 종료 · E2E 주간 회의/ })
  const decision = end.getByRole('radiogroup', { name: 'E2E 안건 작업 결정' })
  await decision.getByRole('radio', { name: '담당 지정' }).click()
  await end.getByRole('combobox', { name: '담당자' }).selectOption({ label: '김하늘' })
  for (const title of seeded) await expect(end.getByRole('radiogroup', { name: `${title} 결정` }).getByRole('radio', { name: '보류' })).toBeChecked()
  await end.getByPlaceholder(/결정 배경/).fill('E2E 메모: 김하늘 님이 맡기로 했어요')
  await end.getByRole('button', { name: '회의 종료 · 결정 1건 적용' }).click()
  await expect(end).toBeHidden()
  await expect(page.getByText('회의를 마쳤어요 · 결정 1건 적용')).toBeVisible()

  // State: task assigned and off the agenda, kept ones still on it, meeting ended with notes.
  await expect.poll(async () => (await taskByTitle(page, 'E2E 안건 작업')).assigneeId).toBe('m_1')
  expect((await taskByTitle(page, 'E2E 안건 작업')).onAgenda).toBe(false)
  for (const title of seeded) expect((await taskByTitle(page, title)).onAgenda).toBe(true)
  const ended = await page.evaluate(async () => {
    const { useOffice } = await import(/* @vite-ignore */ ('/src/store.ts' as string))
    return (Object.values(useOffice.getState().meetings) as { title: string; status: string; notes: string; outcomes: { action: string }[] }[]).find((m) => m.title === 'E2E 주간 회의')
  })
  expect(ended?.status).toBe('ended')
  expect(ended?.notes).toBe('E2E 메모: 김하늘 님이 맡기로 했어요')
  expect(ended?.outcomes.map((o) => o.action)).toEqual(['assign']) // kept items simply carry no outcome
  if (source === 'api') {
    const ws = await serverWorkspace(api)
    const m = ws.meetings.find((x) => x.title === 'E2E 주간 회의')
    expect(m?.status).toBe('ended')
    expect(m?.notes).toBe('E2E 메모: 김하늘 님이 맡기로 했어요')
    expect(ws.tasks.find((t) => t.id === task.id)).toMatchObject({ assigneeId: 'm_1', onAgenda: false })
  }
  await expect(page.getByRole('button', { name: /^회의/ })).toBeVisible()

  // The minutes list shows the entry with the decision and the notes.
  await page.getByRole('button', { name: '더보기' }).click()
  await page.getByRole('menuitem', { name: '회의록' }).click()
  const minutes = page.getByRole('dialog', { name: '회의록' })
  const entry = minutes.getByRole('listitem').filter({ hasText: 'E2E 주간 회의' })
  await expect(entry).toBeVisible()
  await expect(entry.getByText('결정 1건')).toBeVisible()
  await expect(entry.getByText('보류 2건')).toBeVisible()
  await expect(entry.getByText('김하늘 님에게 배정')).toBeVisible()
  await expect(entry.getByText('E2E 메모: 김하늘 님이 맡기로 했어요')).toBeVisible()
})
