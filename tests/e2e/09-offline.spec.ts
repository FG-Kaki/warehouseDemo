// 9. (api only) Server outage: the offline banner appears, and after the server is back it clears and data flows again.
// Uses its own throwaway stack (API :8791 + Vite :5181) so the shared one stays up for other tests; the API process is
// stopped and restarted by its own handle.
import { request } from '@playwright/test'
import { expect, readStore, taskCard, test } from './fixtures'
import { startApi, startWeb, type Proc } from './stack'

const API2 = 8791
const WEB2 = 5181

test.skip(({ source }) => source !== 'api', 'api source only')
test.use({ allowConsoleErrors: true }) // failed fetches and proxy errors are the point of this test

test('offline banner while the API is down; recovers and live data flows when it is back', async ({ page }) => {
  test.setTimeout(150_000)
  const procs: Proc[] = []
  try {
    let api = await startApi(API2)
    procs.push(api)
    procs.push(await startWeb(WEB2, API2))

    await page.goto(`http://127.0.0.1:${WEB2}/?source=api`)
    await expect.poll(() => readStore(page, (s) => s.connection), { timeout: 30_000 }).toBe('online')
    await expect.poll(() => readStore(page, (s) => s.status)).toBe('ready')
    const offlineBanner = page.getByText('서버에 연결할 수 없어요')
    await expect(offlineBanner).toBeHidden()

    // Kill the API.
    await api.stop()
    await expect(offlineBanner).toBeVisible({ timeout: 30_000 })
    expect(await readStore(page, (s) => s.connection)).toBe('offline')
    // The app is still usable read-only: the data is still on screen.
    expect(await readStore(page, (s) => Object.keys(s.tasks).length)).toBeGreaterThan(0)

    // Bring it back (fresh in-memory data on the same port): the banner clears by itself.
    api = await startApi(API2)
    procs.push(api)
    await expect(offlineBanner).toBeHidden({ timeout: 45_000 })
    await expect.poll(() => readStore(page, (s) => s.connection)).toBe('online')

    // A change made by someone else, straight on the API, shows up live.
    const direct = await request.newContext({ baseURL: `http://127.0.0.1:${API2}` })
    const res = await direct.post('/api/tasks', { data: { title: 'E2E 복구 후 작업', projectId: 'p_web' } })
    expect(res.status()).toBe(201)
    await direct.dispose()
    await expect(taskCard(page, 'E2E 복구 후 작업')).toBeVisible()
  } finally {
    for (const p of procs.reverse()) await p.stop()
  }
})
