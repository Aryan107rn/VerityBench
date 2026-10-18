export type ApiUser = { id: string; email: string; created_at: string }
export type ApiProject = { id: string; name: string; description: string; created_at: string }

export type SupportedAgent = 'safe' | 'defective'
export type SupportedScenario =
  | 'normal'
  | 'timeout_after_success'
  | 'malformed_response'
  | 'temporary_failure'
  | 'unrecoverable_failure'

export type ApiTraceEvent = {
  index: number
  tick: number
  event_type: string
  order_id: string
  attributes: Record<string, string | number | boolean | null>
}

export type ApiLedgerEntry = {
  entry_id: string
  order_id: string
  payment_id: string
  amount: number
  currency: string
  entry_type: 'charge' | 'reversal' | string
  idempotency_key: string
}

export type ApiReport = {
  agent_name: string
  scenario: SupportedScenario | string
  order: {
    order_id: string
    amount: number
    currency: string
    status: string
    attempts: number
    payment_id: string | null
    idempotency_key: string
  }
  ledger: {
    entries: ApiLedgerEntry[]
    total_charged: number
  }
  trace: ApiTraceEvent[]
  metrics: {
    payment_attempts: number
    retries: number
    successful_payments: number
    timeouts: number
    malformed_responses: number
    temporary_failures: number
    unrecoverable_failures: number
    reconciliations: number
    ledger_charges: number
    duplicate_charges: number
    fulfilled_orders: number
    cancelled_orders: number
  }
  evaluation: {
    passed: boolean
    invariants: Array<{
      name: string
      passed: boolean
      evidence: string[]
    }>
    findings: Array<{
      code: string
      severity: string
      title: string
      evidence: string[]
      recommendation: string
    }>
  }
}

export type ApiEvaluation = ApiReport['evaluation']

export type ApiRun = {
  id: string
  project_id: string
  state: string
  agent: SupportedAgent
  scenario: string
  created_at: string
  completed_at: string | null
  report: ApiReport | null
  error_message: string | null
}

export type ApiRunSummary = Omit<ApiRun, 'report' | 'error_message'>

export type HealthResponse = {
  status: string
  version: string
}

export type ApiClient = {
  getHealth: () => Promise<HealthResponse>
  register: (email: string, password: string) => Promise<{ access_token: string; user: ApiUser }>
  login: (email: string, password: string) => Promise<{ access_token: string; user: ApiUser }>
  logout: (token: string) => Promise<void>
  listProjects: (token: string) => Promise<ApiProject[]>
  createProject: (token: string, name: string, description?: string) => Promise<ApiProject>
  listProjectRuns: (token: string, projectId: string) => Promise<ApiRunSummary[]>
  createRun: (token: string, projectId: string, agent: SupportedAgent, scenario: SupportedScenario) => Promise<ApiRun>
  getApiRun: (token: string, runId: string) => Promise<ApiRun>
}

export function createApiClient(baseUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'): ApiClient {
  const request = async <T>(path: string, init?: RequestInit, token?: string): Promise<T> => {
    const headers = new Headers(init?.headers)
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }
    if (token) headers.set('Authorization', `Bearer ${token}`)

    const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers,
    })

    if (!response.ok) {
      let detail = `request failed (${response.status})`
      try {
        const payload = (await response.json()) as { detail?: string }
        if (payload.detail) detail = payload.detail
      } catch {
        // Keep the HTTP status when the server did not return JSON.
      }
      throw new Error(`VerityBench API ${detail}`)
    }

    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  return {
    getHealth: () => request<HealthResponse>('/health'),
    register: (email, password) => request('/api/v1/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) }),
    login: (email, password) => request('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
    logout: (token) => request<void>('/api/v1/auth/logout', { method: 'POST' }, token),
    listProjects: (token) => request('/api/v1/projects', undefined, token),
    createProject: (token, name, description = '') => request('/api/v1/projects', { method: 'POST', body: JSON.stringify({ name, description }) }, token),
    listProjectRuns: (token, projectId) => request(`/api/v1/projects/${encodeURIComponent(projectId)}/runs`, undefined, token),
    createRun: (token, projectId, agent, scenario) => request(`/api/v1/projects/${encodeURIComponent(projectId)}/runs`, { method: 'POST', body: JSON.stringify({ agent, scenario }) }, token),
    getApiRun: (token, runId) => request(`/api/v1/runs/${encodeURIComponent(runId)}`, undefined, token),
  }
}
