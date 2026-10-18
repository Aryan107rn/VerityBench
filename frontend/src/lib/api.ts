import type { Run } from '../types'

export type HealthResponse = {
  status: string
}

export type ApiClient = {
  listRuns: () => Promise<Run[]>
  getRun: (runId: string) => Promise<Run>
  getHealth: () => Promise<HealthResponse>
}

/**
 * Typed transport boundary for the eventual VerityBench API.
 *
 * This client is deliberately not backed by fixtures and is not called by the
 * demo shell. Set VITE_API_URL when a backend is available.
 */
export function createApiClient(baseUrl = import.meta.env.VITE_API_URL ?? '/api'): ApiClient {
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const headers = new Headers(init?.headers)
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }

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
  }
}
