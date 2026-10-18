import type { CoverageItem, EvaluatorResult, Run, TrendPoint } from '../types'

/**
 * Local-only fixtures for the frontend shell. They are intentionally separate
 * from the API client so the UI never implies that demo data came from a server.
 */
export const demoRuns: Run[] = [
  {
    id: 'run-042',
    name: 'Safe recovery retest',
    model: 'safe-sample-agent',
    modelVersion: 'integration v1',
    dataset: 'payment-timeout-suite',
    status: 'completed',
    score: 100,
    scoreDelta: 100,
    completedAt: 'Local deterministic run',
    duration: '7 events',
    cases: 1,
    passedCases: 1,
    tags: ['safe recovery', 'verified'],
  },
  {
    id: 'run-041',
    name: 'Normal order flow',
    model: 'safe-sample-agent',
    modelVersion: 'integration v1',
    dataset: 'payment-timeout-suite',
    status: 'completed',
    score: 100,
    scoreDelta: 0,
    completedAt: 'Local deterministic run',
    duration: '6 events',
    cases: 1,
    passedCases: 1,
    tags: ['normal', 'verified'],
  },
  {
    id: 'run-040',
    name: 'Duplicate payment defect',
    model: 'defective-sample-agent',
    modelVersion: 'integration v1',
    dataset: 'timeout-after-success',
    status: 'needs-review',
    score: 0,
    scoreDelta: -100,
    completedAt: 'Local deterministic run',
    duration: '10 events',
    cases: 1,
    passedCases: 0,
    tags: ['duplicate charge', 'needs fix'],
  },
  {
    id: 'run-039',
    name: 'Malformed response guard',
    model: 'safe-sample-agent',
    modelVersion: 'integration v1',
    dataset: 'malformed-response',
    status: 'completed',
    score: 100,
    scoreDelta: 0,
    completedAt: 'Local deterministic run',
    duration: '7 events',
    cases: 1,
    passedCases: 1,
    tags: ['malformed input', 'verified'],
  },
]

export const demoTrend: TrendPoint[] = [
  { label: 'Normal', value: 100 },
  { label: 'Timeout', value: 100 },
  { label: 'Malformed', value: 100 },
  { label: 'Temporary', value: 100 },
  { label: 'Unrecoverable', value: 100 },
  { label: 'Defect', value: 0 },
  { label: 'Retest', value: 100 },
]

export const demoCoverage: CoverageItem[] = [
  { label: 'Outcome invariants', value: 100, color: 'cyan' },
  { label: 'Payment safety', value: 100, color: 'green' },
  { label: 'Trace evidence', value: 100, color: 'violet' },
  { label: 'Recovery paths', value: 80, color: 'amber' },
]

export const demoEvaluators: EvaluatorResult[] = [
  {
    name: 'Order state invariant',
    description: 'Checks the final order state independently.',
    score: 100,
    passed: 1,
    total: 1,
    status: 'passed',
  },
  {
    name: 'Payment ledger invariant',
    description: 'Detects duplicate or mismatched settlements.',
    score: 100,
    passed: 1,
    total: 1,
    status: 'passed',
  },
  {
    name: 'Timeout reconciliation',
    description: 'Requires provider state reconciliation before fulfillment.',
    score: 100,
    passed: 1,
    total: 1,
    status: 'passed',
  },
  {
    name: 'Trace sufficiency',
    description: 'Confirms the report contains observable evidence.',
    score: 100,
    passed: 1,
    total: 1,
    status: 'attention',
  },
]
