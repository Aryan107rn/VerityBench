export type View = 'overview' | 'dashboard' | 'run' | 'agents' | 'datasets' | 'evaluators' | 'settings' | 'cli'

/** States returned by the persisted execution API, plus legacy fixture labels. */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'cancel_requested'
  | 'passed'
  | 'failed'
  | 'timed_out'
  | 'inconclusive'
  | 'cancelled'
  | 'completed'
  | 'needs-review'

export type Run = {
  id: string
  name: string
  model: string
  modelVersion: string
  dataset: string
  status: RunStatus
  score: number | null
  scoreDelta: number | null
  completedAt: string
  duration: string
  cases: number
  passedCases: number
  caseLabel?: string
  tags: string[]
}

export type EvaluatorResult = {
  name: string
  description: string
  score: number
  passed: number
  total: number
  status: 'passed' | 'attention'
}

export type TrendPoint = {
  label: string
  value: number
}

export type CoverageItem = {
  label: string
  value: number
  color: 'cyan' | 'violet' | 'amber' | 'green'
}
