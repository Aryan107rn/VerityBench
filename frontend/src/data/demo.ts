import type { CoverageItem, EvaluatorResult, Run, TrendPoint } from '../types'

/**
 * Local-only fixtures for the frontend shell. They are intentionally separate
 * from the API client so the UI never implies that demo data came from a server.
 */
export const demoRuns: Run[] = [
  {
    id: 'run-042',
    name: 'Production safety sweep',
    model: 'Atlas 3.1',
    modelVersion: 'atlas-3.1-2025-02',
    dataset: 'safety-core-v4',
    status: 'completed',
    score: 92.8,
    scoreDelta: 3.4,
    completedAt: 'Today, 09:42 UTC',
    duration: '08m 14s',
    cases: 480,
    passedCases: 446,
    tags: ['release gate', 'safety'],
  },
  {
    id: 'run-041',
    name: 'Retrieval regression check',
    model: 'Atlas 3.1',
    modelVersion: 'atlas-3.1-2025-02',
    dataset: 'grounded-qa-v2',
    status: 'completed',
    score: 88.1,
    scoreDelta: -1.2,
    completedAt: 'Yesterday, 16:18 UTC',
    duration: '12m 03s',
    cases: 720,
    passedCases: 634,
    tags: ['regression', 'retrieval'],
  },
  {
    id: 'run-040',
    name: 'Agent tool-use baseline',
    model: 'Nimbus 2.8',
    modelVersion: 'nimbus-2.8-rc3',
    dataset: 'tool-use-smoke-v1',
    status: 'needs-review',
    score: 74.6,
    scoreDelta: -4.8,
    completedAt: 'Yesterday, 11:07 UTC',
    duration: '05m 41s',
    cases: 160,
    passedCases: 119,
    tags: ['agent', 'review'],
  },
  {
    id: 'run-039',
    name: 'Weekly quality baseline',
    model: 'Atlas 3.0',
    modelVersion: 'atlas-3.0-2024-11',
    dataset: 'verity-mix-v7',
    status: 'completed',
    score: 86.4,
    scoreDelta: 2.1,
    completedAt: 'Oct 17, 08:31 UTC',
    duration: '19m 26s',
    cases: 1200,
    passedCases: 1037,
    tags: ['weekly', 'baseline'],
  },
]

export const demoTrend: TrendPoint[] = [
  { label: 'Oct 12', value: 78.4 },
  { label: 'Oct 13', value: 80.2 },
  { label: 'Oct 14', value: 79.7 },
  { label: 'Oct 15', value: 83.1 },
  { label: 'Oct 16', value: 82.6 },
  { label: 'Oct 17', value: 86.4 },
  { label: 'Today', value: 92.8 },
]

export const demoCoverage: CoverageItem[] = [
  { label: 'Correctness', value: 94, color: 'cyan' },
  { label: 'Safety', value: 91, color: 'green' },
  { label: 'Groundedness', value: 87, color: 'violet' },
  { label: 'Tool use', value: 76, color: 'amber' },
]

export const demoEvaluators: EvaluatorResult[] = [
  {
    name: 'Response correctness',
    description: 'Checks answer accuracy against reference criteria.',
    score: 96.2,
    passed: 231,
    total: 240,
    status: 'passed',
  },
  {
    name: 'Safety policy adherence',
    description: 'Flags unsafe completion patterns and policy drift.',
    score: 93.8,
    passed: 225,
    total: 240,
    status: 'passed',
  },
  {
    name: 'Citation groundedness',
    description: 'Measures whether claims are supported by context.',
    score: 89.6,
    passed: 215,
    total: 240,
    status: 'passed',
  },
  {
    name: 'Refusal consistency',
    description: 'Looks for stable behavior across adversarial prompts.',
    score: 82.1,
    passed: 197,
    total: 240,
    status: 'attention',
  },
]
