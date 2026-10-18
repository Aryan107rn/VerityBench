import type { Run } from '../types'

export type ApiUser = { id: string; email: string; created_at: string }
export type ApiProject = { id: string; name: string; description: string; created_at: string }
export type ApiRun = {
  id: string
  project_id: string
  state: string
  agent: 'safe' | 'defective'
  scenario: string
  created_at: string
  completed_at: string | null
  report: Record<string, unknown> | null
  error_message: string | null
}

export type HealthResponse = {
  status: string
  version: string
}

export type ApiClient = {
  listRuns: () => Promise<Run[]>
  getRun: (runId: string) => Promise<Run>
  getHealth: () => Promise<HealthResponse>
  register: (email: string, password: string) => Promise<{ access_token: string; user: ApiUser }>
  login: (email: string, password: string) => Promise<{ access_token: string; user: ApiUser }>
  listProjects: (token: string) => Promise<ApiProject[]>
  createProject: (token: string, name: string, description?: string) => Promise<ApiProject>
  createRun: (token: string, projectId: string, agent: 'safe' | 'defective', scenario: string) => Promise<ApiRun>
  getApiRun: (token: string, runId: string) => Promise<ApiRun>
}

/**
 * Typed transport boundary for the eventual VerityBench API.
 *
 * This client is deliberately not backed by fixtures and is not called by the
 * demo shell. Set VITE_API_URL when a backend is available.
 */
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
      throw new Error(`VerityBench API request failed (${response.status})`)
    }

    return (await response.json()) as T
  }

  return {
    listRuns: () => request<Run[]>('/runs'),
    getRun: (runId: string) => request<Run>(`/runs/${encodeURIComponent(runId)}`),
    getHealth: () => request<HealthResponse>('/health'),
    register: (email, password) => request('/api/v1/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) }),
    login: (email, password) => request('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
    listProjects: (token) => request('/api/v1/projects', undefined, token),
    createProject: (token, name, description = '') => request('/api/v1/projects', { method: 'POST', body: JSON.stringify({ name, description }) }, token),
    createRun: (token, projectId, agent, scenario) => request(`/api/v1/projects/${encodeURIComponent(projectId)}/runs`, { method: 'POST', body: JSON.stringify({ agent, scenario }) }, token),
    getApiRun: (token, runId) => request(`/api/v1/runs/${encodeURIComponent(runId)}`, undefined, token),
  }
}
