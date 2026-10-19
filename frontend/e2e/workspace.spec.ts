import { expect, test as base, type Page } from '@playwright/test'

// All API traffic is intercepted before the first navigation. Unexpected API
// calls and external requests are blocked and fail the test, never forwarded.
const test = base.extend<{ fixtureNetwork: void }>({
  fixtureNetwork: [async ({ context, baseURL }, use) => {
    const unexpected: string[] = []
    await context.route('**/*', async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.origin !== baseURL) {
        unexpected.push(`${request.method()} ${request.url()}`)
        await route.abort('blockedbyclient')
      } else if (url.pathname === '/health' && request.method() === 'GET') {
        await route.fulfill({ json: { status: 'ok', version: 'e2e-fixture' } })
      } else if (url.pathname.startsWith('/api/')) {
        unexpected.push(`${request.method()} ${url.pathname}`)
        await route.fulfill({ status: 503, json: { detail: 'No backend in fixture tests' } })
      } else {
        await route.continue()
      }
    })
    await use()
    expect(unexpected, 'Fixture browsing must not access a backend or external service').toEqual([])
  }, { auto: true }],
})

function navigationItem(page: Page, name: RegExp) {
  const navigation = page.getByRole('navigation', { name: /main navigation/i })
  return navigation.getByRole('button', { name }).or(navigation.getByRole('link', { name }))
}

test('defaults to dark and navigates Overview, Agent runs, Agents, Settings; theme survives reload', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark')
  await expect(navigationItem(page, /^Overview\b/i)).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible()

  for (const [name, path] of [
    ['Agent runs', '/runs'],
    ['Agents', '/agents'],
    ['Settings', '/settings'],
  ] as const) {
    await navigationItem(page, new RegExp(`^${name}\\b`, 'i')).click()
    await expect(page).toHaveURL(new RegExp(`${path}$`))
    await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible()
    await expect(navigationItem(page, new RegExp(`^${name}\\b`, 'i'))).toHaveAttribute('aria-current', 'page')
  }

  await page.getByRole('button', { name: /switch to light theme/i }).click()
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.getByRole('button', { name: /switch to dark theme/i })).toBeVisible()

  // Exercise the settings preference as well as the shell toggle.
  await page.getByRole('main').getByRole('button', { name: /^Dark\b/i }).click()
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark')
  await navigationItem(page, /^Overview\b/i).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(navigationItem(page, /^Overview\b/i)).toHaveAttribute('aria-current', 'page')
})

test('searches and filters fixture runs, handles no results, and opens the matching run', async ({ page }) => {
  await page.goto('/runs')
  const table = page.getByRole('table')
  // The no-results message is also a table row, but has no run-opening button.
  const rows = table.getByRole('row')
    .filter({ has: page.getByRole('cell') })
    .filter({ has: page.getByRole('button') })
  const search = page.getByRole('textbox', { name: /filter runs|search runs/i })
  await expect(rows).toHaveCount(4)

  await search.fill('RUN-042')
  await expect(rows).toHaveCount(1)
  await expect(rows).toContainText('Safe recovery retest')
  await search.fill('not-a-real-fixture-run')
  await expect(rows).toHaveCount(0)
  await expect(table.getByRole('cell', { name: /no (local fixtures|runs).*match/i })).toBeVisible()

  await search.fill('')
  await page.getByRole('button', { name: /^Needs review\b/i }).click()
  await expect(rows).toHaveCount(1)
  await expect(rows).toContainText('Duplicate payment defect')
  await search.fill('safe recovery')
  await expect(rows).toHaveCount(0)

  await page.getByRole('button', { name: /^All( runs)?$/i }).click()
  await search.fill('payment-timeout-suite')
  await expect(rows).toHaveCount(2)
  await search.fill('run-042')
  await table.getByRole('button', { name: /^Safe recovery retest\b/i }).click()
  await expect(page).toHaveURL(/\/runs\/run-042$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Safe recovery retest' })).toBeVisible()
  await expect(page.getByText('Local fixture only', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /export json/i })).toHaveCount(0)
  await page.getByRole('button', { name: /^Back to runs$/i }).click()
  await expect(page).toHaveURL(/\/runs$/)
  await expect(rows).toHaveCount(4)
})

test('command search supports keyboard navigation and opens a loaded run', async ({ page }) => {
  await page.goto('/')
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Search workspace' })
  await expect(palette).toBeVisible()
  const query = palette.getByRole('combobox', { name: 'Search pages and runs' })
  await query.fill('run-040')
  await expect(palette.getByRole('option')).toHaveCount(1)
  await query.press('Enter')
  await expect(page).toHaveURL(/\/runs\/run-040$/)
  await expect(palette).toHaveCount(0)

  await page.keyboard.press('Control+k')
  await expect(palette).toBeVisible()
  await palette.getByRole('combobox').fill('not-in-workspace')
  await expect(palette).toContainText('No pages or loaded runs match')
  await page.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)
})

test('compares loaded results, sorts names and scores, and focuses search with slash', async ({ page }) => {
  await page.goto('/runs')
  const table = page.getByRole('table')
  await page.getByRole('button', { name: 'Compare runs', exact: true }).click()
  const comparison = page.getByRole('region', { name: 'Compare loaded runs' })
  await expect(comparison).toBeVisible()
  await comparison.getByLabel('Run B').selectOption('run-040')
  await expect(comparison).toContainText('0%')
  await expect(comparison).toContainText('100%')
  await page.getByRole('button', { name: 'Close comparison', exact: true }).click()
  await expect(comparison).toHaveCount(0)

  await table.getByRole('button', { name: /^Experiment/ }).click()
  await expect(table.locator('tbody tr').first()).toContainText('Duplicate payment defect')
  await table.getByRole('button', { name: /^Score/ }).click()
  await expect(table.locator('tbody tr').last()).toContainText('Duplicate payment defect')
  await page.keyboard.press('/')
  await expect(page.getByRole('textbox', { name: 'Filter runs' })).toBeFocused()
  await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Previous page' })).toBeDisabled()
})

test('charts open their source runs and sidebar can be compacted', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  await expect(page.locator('.app-shell')).toHaveClass(/sidebar-is-compact/)
  await expect(navigationItem(page, /^Overview\b/i)).toBeVisible()
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
  await page.getByRole('region', { name: 'Evaluation scores', exact: true }).getByRole('button', { name: /Open Safe recovery retest/ }).click()
  await expect(page).toHaveURL(/\/runs\/run-042$/)
})

test('CLI guide leads with install and private local testing before advanced HTTP usage', async ({ page }) => {
  await page.goto('/cli')
  await expect(page.getByRole('heading', { level: 1, name: 'CLI guide' })).toBeVisible()
  await expect(page.getByText('Private local mode.', { exact: false })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: 'Install the CLI' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: 'Test locally' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: 'HTTP API / Advanced Usage' })).toBeVisible()
  await expect(page.locator('code').filter({ hasText: 'python -m pip install .' }).first()).toBeVisible()
  await expect(page.getByText('veritybench test', { exact: false }).first()).toBeVisible()
})

test('captures the reference-inspired overview and experiments for visual review', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1040 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Evaluator breakdown', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('overview.png'), fullPage: true })
  await navigationItem(page, /^Agent runs\b/i).click()
  await expect(page.getByRole('heading', { name: 'Check outcomes', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('experiments.png'), fullPage: true })
})

for (const width of [390, 320]) {
  test(`mobile ${width}px: workspace pages and fixture detail have no horizontal page overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    for (const path of ['/', '/runs', '/agents', '/settings', '/runs/run-042']) {
      await page.goto(path)
      await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible()
      await expect.poll(() => page.evaluate(() => {
        const viewport = document.documentElement.clientWidth
        return Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - viewport
      }), { message: `${path} must fit a ${width}px viewport (local scrollers are allowed)` }).toBeLessThanOrEqual(1)
    }
  })
}
