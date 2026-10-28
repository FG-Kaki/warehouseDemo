// End-to-end suite (OWNER: qa-engineer). Drives the installed Chrome (channel 'chrome', no browser download)
// against its own Vite dev server (:5180) and its own in-memory API (:8790), so dev servers on
// :5173 / :8787 are never touched. Every spec runs twice: project `mock` (/) and project `api` (/?source=api).
import { defineConfig } from '@playwright/test'
import { API_PORT, WEB_PORT } from './tests/e2e/env'
import type { OfficeOptions } from './tests/e2e/fixtures'

export default defineConfig<OfficeOptions>({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  // The API projects share one in-memory server that every test resets, so tests run one at a time.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
    // Use the GPU when there is one; fall back to software WebGL (SwiftShader) on machines without it.
    launchOptions: { args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'mock', use: { source: 'mock' } },
    { name: 'api', use: { source: 'api' } },
  ],
  webServer: [
    {
      command: 'node --import tsx tests/e2e/serve-api.ts',
      env: { PORT: String(API_PORT) },
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `node node_modules/vite/bin/vite.js --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      env: { API_PORT: String(API_PORT) },
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 90_000,
    },
  ],
})
