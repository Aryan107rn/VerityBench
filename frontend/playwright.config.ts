import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

// Install the matching browser locally (from frontend/):
// PLAYWRIGHT_BROWSERS_PATH=./node_modules/.cache/ms-playwright npx playwright install chromium
process.env.PLAYWRIGHT_BROWSERS_PATH ??= fileURLToPath(new URL('./node_modules/.cache/ms-playwright', import.meta.url))

const baseURL = 'http://127.0.0.1:4175'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 7_500 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    // Each test starts with an empty, non-persistent browser context.
    storageState: { cookies: [], origins: [] },
    serviceWorkers: 'block',
    colorScheme: 'light', // The product default must still be dark.
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4175 --strictPort',
    url: baseURL,
    // Never reuse a developer server with an unknown API URL or environment.
    reuseExistingServer: false,
    env: { VITE_API_URL: baseURL, BROWSER: 'none' },
    timeout: 30_000,
  },
})
