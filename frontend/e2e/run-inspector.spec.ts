import { expect, test as base, type Locator, type Page } from '@playwright/test'
import type { ApiReport, ApiRun, ApiRunEvent } from '../src/lib/api'

const projectId = 'e2e-project'
const runId = 'e2e-run-safe-timeout'
const mockToken = 'e2e-only-not-a-real-session'
const createdAt = '2026-10-19T10:00:00.000Z'

const report: ApiReport = {
  agent_name: 'safe-sample-agent',
  scenario: 'timeout_after_success',
  order: {
    order_id: 'order-e2e-100', amount: 4200, currency: 'USD', status: 'fulfilled',
    attempts: 1, payment_id: 'payment-e2e-100', idempotency_key: 'e2e-stable-key',
  },
  ledger: {
    total_charged: 4200,
    entries: [{
      entry_id: 'ledger-e2e-100', order_id: 'order-e2e-100', payment_id: 'payment-e2e-100',
      amount: 4200, currency: 'USD', entry_type: 'charge', idempotency_key: 'e2e-stable-key',
    }],
  },
  trace: [
    { index: 0, tick: 0, event_type: 'payment_attempted', order_id: 'order-e2e-100', attributes: { idempotency_key: 'e2e-stable-key', amount: 4200 } },
    { index: 1, tick: 1, event_type: 'payment_reconciled', order_id: 'order-e2e-100', attributes: { payment_id: 'payment-e2e-100', status: 'succeeded' } },
  ],
  metrics: {
    payment_attempts: 1, retries: 0, successful_payments: 1, timeouts: 1,
    malformed_responses: 0, malformed_tool_responses: 0, temporary_failures: 0, unrecoverable_failures: 0,
    reconciliations: 1, ledger_charges: 1, duplicate_charges: 0, fulfilled_orders: 1, cancelled_orders: 0,
    rate_limited: 0, tool_exceptions: 0, conflicting_outputs: 0, malicious_outputs: 0,
  },
  evaluation: {
    passed: true,
    invariants: [
      { name: 'One charge per order', passed: true, evidence: ['Exactly one ledger charge: ledger-e2e-100'] },
      { name: 'Fulfill only after reconciliation', passed: true, evidence: ['Payment payment-e2e-100 confirmed before fulfillment'] },
    ],
    findings: [],
  },
}

function makeRun(live: boolean): ApiRun {
  return {
    id: runId, project_id: projectId, state: live ? 'running' : 'passed',
    agent: 'safe', scenario: 'timeout_after_success', cancel_requested: false,
    created_at: createdAt, started_at: createdAt,
    completed_at: live ? null : '2026-10-19T10:00:05.000Z',
    report: live ? null : report, error_message: null,
  }
}

function makeEvent(sequence: number, eventType: string, payload: Record<string, unknown>): ApiRunEvent {
  return {
    id: `e2e-event-${sequence}`, run_id: runId, sequence, schema_version: 1,
    event_type: eventType, payload,
    created_at: `2026-10-19T10:00:0${sequence}.000Z`,
  }
}

const history = [
  makeEvent(0, 'run_started', { state: 'running', agent: 'safe', marker: 'e2e-start-payload' }),
  makeEvent(1, 'agent_decision', { action: 'pay', reason: 'e2e-agent-decision', order_id: 'order-e2e-100' }),
  makeEvent(2, 'payment_attempted', { amount: 4200, currency: 'USD', idempotency_key: 'e2e-stable-key', marker: 'e2e-payment-payload' }),
]
const terminalEvents = [
  makeEvent(3, 'payment_reconciled', { payment_id: 'payment-e2e-100', status: 'succeeded' }),
  makeEvent(4, 'run_completed', { state: 'passed', marker: 'e2e-terminal-payload' }),
]

type MockApi = { complete: () => void; streamRequests: () => number }
const test = base.extend<{ liveRun: boolean; mockApi: MockApi }>({
  liveRun: [false, { option: true }],
  mockApi: [async ({ context, baseURL, liveRun }, use) => {
    let completed = !liveRun
    let streamRequests = 0
    let releaseStream = () => {}
    const streamGate = new Promise<void>((resolve) => { releaseStream = resolve })
    const unexpected: string[] = []

    // Seed a synthetic session, never a user's browser profile or credentials.
    await context.addInitScript(({ origin, projectId, mockToken, createdAt }) => {
      if (window.location.origin !== origin) return
      window.localStorage.setItem('veritybench.session', JSON.stringify({
        token: mockToken,
        user: { id: 'e2e-user', email: 'browser-test@example.invalid', created_at: createdAt },
      }))
      window.localStorage.setItem('veritybench.project', projectId)
    }, { origin: baseURL!, projectId, mockToken, createdAt })

    await context.route('**/*', async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.origin !== baseURL) {
        unexpected.push(`${request.method()} ${request.url()}`)
        await route.abort('blockedbyclient')
        return
      }
      if (url.pathname === '/health' && request.method() === 'GET') {
        await route.fulfill({ json: { status: 'ok', version: 'e2e-mocked-api' } })
        return
      }
      if (!url.pathname.startsWith('/api/')) {
        await route.continue()
        return
      }
      // Every protected call must carry only our synthetic session token.
      if (request.method() !== 'GET' || request.headers().authorization !== `Bearer ${mockToken}`) {
        unexpected.push(`${request.method()} ${url.pathname} (unexpected method or session)`)
        await route.fulfill({ status: 403, json: { detail: 'Synthetic session required' } })
        return
      }

      const project = { id: projectId, name: 'Browser regression project', description: 'Isolated Playwright data', created_at: createdAt }
      const currentRun = () => makeRun(!completed)
      if (url.pathname === '/api/v1/auth/me') {
        await route.fulfill({ json: { id: 'e2e-user', email: 'browser-test@example.invalid', created_at: createdAt } })
      } else if (url.pathname === '/api/v1/projects') {
        await route.fulfill({ json: [project] })
      } else if (url.pathname === `/api/v1/projects/${projectId}`) {
        await route.fulfill({ json: project })
      } else if (url.pathname === `/api/v1/projects/${projectId}/agents`) {
        await route.fulfill({ json: [{ key: 'safe', name: 'safe-sample-agent', description: 'Mocked repository agent', source: 'repository', runnable: true, supported_scenarios: ['timeout_after_success'] }] })
      } else if (url.pathname === '/api/v1/scenarios') {
        await route.fulfill({ json: [{ id: 'timeout_after_success', name: 'Timeout after success', category: 'api/network', description: 'A charge succeeds but its response is lost.', expected_outcome: 'Reconcile before fulfillment.', deterministic: true, supported_agent_contract: 1, parameters: [], execution_limits: { max_retries_default: 2, max_steps_default: 20 } }] })
      } else if (url.pathname === `/api/v1/projects/${projectId}/runs`) {
        const { report: _report, error_message: _error, ...summary } = currentRun()
        await route.fulfill({ json: [summary] })
      } else if (url.pathname === `/api/v1/runs/${runId}`) {
        await route.fulfill({ json: currentRun() })
      } else if (url.pathname === `/api/v1/runs/${runId}/events`) {
        const after = Number(url.searchParams.get('after_sequence') ?? -1)
        await route.fulfill({ json: [...history, ...(completed ? terminalEvents : [])].filter((event) => event.sequence > after) })
      } else if (url.pathname === `/api/v1/runs/${runId}/events/stream`) {
        streamRequests += 1
        await streamGate
        const after = Number(url.searchParams.get('after_sequence') ?? -1)
        await route.fulfill({
          contentType: 'text/event-stream',
          headers: { 'Cache-Control': 'no-cache' },
          body: terminalEvents.filter((event) => event.sequence > after)
            .map((event) => `id: ${event.sequence}\nevent: run_event\ndata: ${JSON.stringify(event)}\n\n`).join(''),
        })
      } else {
        unexpected.push(`${request.method()} ${url.pathname}`)
        await route.fulfill({ status: 404, json: { detail: 'Unmocked API request' } })
      }
    })

    await use({
      complete: () => { completed = true; releaseStream() },
      streamRequests: () => streamRequests,
    })
    releaseStream()
    expect(unexpected, 'All protected API traffic must stay inside the mock').toEqual([])
  }, { auto: true }],
})

function timeline(page: Page) {
  return page.getByRole('log', { name: /run event timeline|execution timeline|trace timeline/i })
}

function inspector(page: Page) {
  return page.getByRole('region', { name: /selected event details|event inspector|trace inspector/i })
}

async function selectEvent(page: Page, name: RegExp, marker: string) {
  const row = timeline(page).getByRole('button', { name })
  await row.click()
  await expect(row).toHaveAttribute('aria-pressed', 'true')
  await expect(inspector(page).getByRole('heading', { name })).toBeVisible()
  await expect(inspector(page)).toContainText(marker)
  return row
}

async function selectTab(details: Locator, name: RegExp) {
  // Intentionally require actual accessible tabs; cosmetic buttons are not tabs.
  const tab = details.getByRole('tab', { name })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  return details.getByRole('tabpanel').filter({ visible: true })
}

test('terminal ApiRun: selecting events updates the inspector and payload tabs', async ({ page }, testInfo) => {
  await page.goto(`/runs/${runId}`)
  await expect(page.getByRole('heading', { level: 1, name: /run execution/i })).toBeVisible()
  await expect(timeline(page).getByRole('button')).toHaveCount(5)
  await selectEvent(page, /payment[ _]attempted/i, 'e2e-payment-payload')

  const details = inspector(page)
  const payload = await selectTab(details, /^(payload|json|raw( payload)?)(\s*json)?$/i)
  await expect(payload).toContainText('e2e-stable-key')
  await expect(payload).toContainText('4200')
  const metadata = await selectTab(details, /^(attributes|details|metadata|event)$/i)
  await expect(metadata).toContainText('e2e-event-2')
  await expect(metadata).not.toContainText('e2e-payment-payload')
  const overview = await selectTab(details, /^(overview|summary)$/i)
  await expect(overview).toContainText('e2e-payment-payload')
  await selectTab(details, /^(payload|json|raw( payload)?)(\s*json)?$/i)
  await selectEvent(page, /agent[ _]decision/i, 'e2e-agent-decision')
  await expect(details).not.toContainText('e2e-payment-payload')

  await page.getByRole('searchbox', { name: /search events/i })
    .or(page.getByRole('textbox', { name: /search events/i })).fill('e2e-agent-decision')
  await expect(timeline(page).getByRole('button')).toHaveCount(1)
  await expect(timeline(page)).toContainText(/agent[ _]decision/i)
  await page.setViewportSize({ width: 1600, height: 1040 })
  await page.getByRole('searchbox', { name: /search events/i }).fill('')
  await selectEvent(page, /payment[ _]attempted/i, 'e2e-payment-payload')
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: testInfo.outputPath('trace-inspector.png'), fullPage: true })
})

test('report section tabs expose actual evaluation, ledger, and finding records', async ({ page }) => {
  await page.goto(`/runs/${runId}`)
  const tabs = page.getByRole('tablist', { name: 'Run evidence sections' })
  await tabs.getByRole('tab', { name: /^Evaluation/ }).click()
  await expect(page.getByText('One charge per order', { exact: true })).toBeVisible()
  await tabs.getByRole('tab', { name: /^Ledger/ }).click()
  await expect(page.getByRole('heading', { name: 'ledger-e2e-100', exact: true })).toBeVisible()
  await tabs.getByRole('tab', { name: /^Findings/ }).click()
  await expect(page.getByText('No findings recorded for this report.', { exact: true })).toBeVisible()
  await tabs.getByRole('tab', { name: /^Trace/ }).click()
  await expect(timeline(page).getByRole('button')).toHaveCount(5)
})

test.describe('live mocked event stream', () => {
  test.use({ liveRun: true })

  test('keeps an inspected event selected while live events arrive and a terminal report appears', async ({ page, mockApi }) => {
    await page.goto(`/runs/${runId}`)
    await expect(page.getByRole('heading', { level: 1, name: /live execution/i })).toBeVisible()
    await expect(timeline(page).getByRole('button')).toHaveCount(3)
    await expect(page.getByRole('button', { name: /^Cancel run$/i })).toBeEnabled()
    await expect(page.getByRole('button', { name: /export json/i })).toHaveCount(0)
    await expect.poll(mockApi.streamRequests).toBeGreaterThan(0)
    const selected = await selectEvent(page, /payment[ _]attempted/i, 'e2e-payment-payload')

    // This resolves a real intercepted fetch/SSE response, not component state.
    mockApi.complete()
    await expect(timeline(page).getByRole('button')).toHaveCount(5)
    await expect(page.getByRole('heading', { level: 1, name: /run execution/i })).toBeVisible()
    await expect(selected).toHaveAttribute('aria-pressed', 'true')
    await expect(inspector(page)).toContainText('e2e-payment-payload')
    await expect(page.getByRole('button', { name: /^Cancel run$/i })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /export json/i })).toBeVisible()
    await selectEvent(page, /run[ _]completed/i, 'e2e-terminal-payload')
  })
})

test('exports the terminal persisted report as a JSON browser download', async ({ page }) => {
  await page.goto(`/runs/${runId}`)
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: /export json/i }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe(`${runId}-report.json`)
  expect(await download.failure()).toBeNull()
  const stream = await download.createReadStream()
  if (!stream) throw new Error('The browser did not return a readable report download')
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual(report)
})

test('mobile trace inspector and JSON payload stay within the page viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/runs/${runId}`)
  await selectEvent(page, /payment[ _]attempted/i, 'e2e-payment-payload')
  const payload = await selectTab(inspector(page), /^(payload|json|raw( payload)?)(\s*json)?$/i)
  await expect(payload).toContainText('e2e-stable-key')
  await expect.poll(() => page.evaluate(() =>
    Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth,
  ), { message: 'The trace inspector must not cause horizontal page overflow on mobile' }).toBeLessThanOrEqual(1)
})
