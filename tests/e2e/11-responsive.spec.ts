// 11. Responsive: at 1024x768 and 768x1024 the management rail is an overlay drawer over the 3D office.
import { expect, openApp, test } from './fixtures'

for (const vp of [
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
]) {
  test.describe(`${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp })

    test('drawer opens and closes, top-bar actions stay clickable, the office stays visible', async ({ page, source }) => {
      await openApp(page, source)
      const drawer = page.getByRole('region', { name: '관리 패널' })
      const open = page.getByRole('button', { name: '관리 패널', exact: true })
      const canvas = page.locator('canvas')

      // Narrow screens start with the rail collapsed; the office fills the screen.
      await expect(drawer).toBeHidden()
      await expect(canvas).toBeVisible()
      const box = await canvas.boundingBox()
      expect(box?.width).toBeGreaterThanOrEqual(vp.width - 1)

      // Open, close with the button.
      await open.click()
      await expect(drawer).toBeVisible()
      await expect(canvas).toBeVisible()
      await drawer.getByRole('button', { name: '패널 접기' }).click()
      await expect(drawer).toBeHidden()

      // Open, close with Escape.
      await open.click()
      await expect(drawer).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(drawer).toBeHidden()

      // Open, close with a tap on the office.
      await open.click()
      await expect(drawer).toBeVisible()
      await page.mouse.click(Math.round(vp.width * 0.08), Math.round(vp.height * 0.5))
      await expect(drawer).toBeHidden()

      // Top-bar actions are reachable with the drawer open: nothing covers them, and they work.
      await open.click()
      await expect(drawer).toBeVisible()
      for (const [name, dialog] of [
        ['작업', '새 작업'],
        ['회의', '회의 시작'],
      ] as const) {
        const button = page.getByRole('banner').getByRole('button', { name: new RegExp(`^${name}`) })
        await expect(button).toBeVisible()
        const covered = await button.evaluate((el) => {
          const r = el.getBoundingClientRect()
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          return !(hit && el.contains(hit))
        })
        expect(covered, `top-bar "${name}" button is covered by the drawer`).toBe(false)
        await button.click()
        await expect(page.getByRole('dialog', { name: dialog })).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog', { name: dialog })).toBeHidden()
        if (!(await drawer.isVisible())) {
          await open.click()
          await expect(drawer).toBeVisible()
        }
      }
    })
  })
}
