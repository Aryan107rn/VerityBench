import { createContext, useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { BrowserRouter, useLocation, useNavigate } from 'react-router-dom'
import { AgentsPage } from './components/AgentsPage'
import { CommandPalette, type WorkspaceCommand } from './components/CommandPalette'
import { Icon, type IconName } from './components/Icon'
import { ObservabilityDashboard } from './components/ObservabilityDashboard'
import { RunExecutionView } from './components/RunExecutionView'
import { demoCoverage, demoEvaluators, demoRuns } from './data/demo'
import {
  createApiClient,
  type ApiClient,
  type ApiAgent,
  type ApiEvaluation,
  type ApiProject,
  type ApiReport,
  type ApiRun,
  type ApiScenario,
  type ApiUser,
  type SupportedAgent,
  type SupportedScenario,
} from './lib/api'
import type { CoverageItem, EvaluatorResult, Run, RunStatus, TrendPoint, View } from './types'

type Session = { token: string; user: ApiUser }
type Theme = 'light' | 'dark'
type ApiStatus = 'checking' | 'online' | 'offline'
type LocalDataset = {
  id: string
  name: string
  description: string
  cases: number
  kind: 'fixture' | 'local'
  updated: string
}
type LocalSettings = { showFixtureHints: boolean; compactRows: boolean }

type DashboardStats = {
  passRate: string
  evaluated: string
  traceCount: string
  duplicateCharges: string
  safeRetests: string
}

const sessionStorageKey = 'veritybench.session'
const projectStorageKey = 'veritybench.project'
const themeStorageKey = 'veritybench.theme'
const datasetsStorageKey = 'veritybench.local-datasets'
const evaluatorStorageKey = 'veritybench.local-evaluators'
const settingsStorageKey = 'veritybench.local-settings'

const navItems: Array<{ id: View; label: string; icon: IconName; path: string }> = [
  { id: 'overview', label: 'Overview', icon: 'layers', path: '/' },
  { id: 'dashboard', label: 'Agent runs', icon: 'activity', path: '/runs' },
  { id: 'agents', label: 'Agents', icon: 'sparkles', path: '/agents' },
  { id: 'datasets', label: 'Datasets', icon: 'database', path: '/datasets' },
  { id: 'evaluators', label: 'Evaluators', icon: 'sliders', path: '/evaluators' },
  { id: 'settings', label: 'Settings', icon: 'settings', path: '/settings' },
  { id: 'cli', label: 'CLI guide', icon: 'terminal', path: '/cli' },
]

const viewLabels: Record<View, string> = {
  overview: 'Overview',
  dashboard: 'Agent runs',
  run: 'Run detail',
  agents: 'Agents',
  datasets: 'Datasets',
  evaluators: 'Evaluators',
  settings: 'Settings',
  cli: 'CLI guide',
}

type ScenarioOption = { value: SupportedScenario; label: string; description: string; category?: string; parameters?: ApiScenario['parameters']; expectedOutcome?: string }

const scenarios: ScenarioOption[] = [
  { value: 'normal', label: 'Normal payment', description: 'Provider returns a successful payment response.' },
  { value: 'timeout_after_success', label: 'Timeout after success', description: 'A charge succeeds but its response is lost.' },
  { value: 'malformed_response', label: 'Malformed response', description: 'The provider returns an unreadable response.' },
  { value: 'temporary_failure', label: 'Temporary failure', description: 'The first payment attempt fails temporarily.' },
  { value: 'unrecoverable_failure', label: 'Unrecoverable failure', description: 'Every payment attempt remains unsuccessful.' },
  { value: 'transient_failure', label: 'Transient failure', description: 'A configurable number of provider failures precede recovery.' },
  { value: 'rate_limited', label: 'HTTP 429 rate limit', description: 'Rate-limit responses test bounded backoff and retry behavior.' },
  { value: 'tool_exception', label: 'Tool exception', description: 'The payment tool raises a controlled exception fixture.' },
  { value: 'malformed_tool_response', label: 'Malformed tool response', description: 'A tool returns an unparseable response fixture.' },
  { value: 'retry_exhaustion', label: 'Retry exhaustion', description: 'Transient faults continue until the retry budget is exhausted.' },
  { value: 'duplicate_operation', label: 'Duplicate operation', description: 'A lost response tests duplicate settlement prevention.' },
  { value: 'conflicting_tool_output', label: 'Conflicting tool output', description: 'A tool output conflicts with the operation context.' },
  { value: 'malicious_tool_output', label: 'Malicious tool output', description: 'Instruction-like tool output must be treated as untrusted data.' },
]

const localRunAgents: ApiAgent[] = [
  { key: 'safe', name: 'safe-sample-agent', description: 'Reconciles uncertainty safely.', source: 'repository', runnable: true, supported_scenarios: scenarios.map((scenario) => scenario.value) },
  { key: 'defective', name: 'defective-sample-agent', description: 'Demonstrates a duplicate-payment defect.', source: 'repository', runnable: true, supported_scenarios: scenarios.map((scenario) => scenario.value) },
]

const AgentCatalogContext = createContext<ApiAgent[]>(localRunAgents)

const scenarioLabels: Record<SupportedScenario, string> = Object.fromEntries(
  scenarios.map((scenario) => [scenario.value, scenario.label]),
) as Record<SupportedScenario, string>

const defaultDatasets: LocalDataset[] = [
  { id: 'payment-timeout-suite', name: 'Payment timeout suite', description: 'Controlled payment outcomes for retry and reconciliation behavior.', cases: 5, kind: 'fixture', updated: 'Repository fixture' },
  { id: 'malformed-response', name: 'Malformed response', description: 'Provider payloads that test schema validation and safe failure handling.', cases: 3, kind: 'fixture', updated: 'Repository fixture' },
  { id: 'local-checkout-smoke', name: 'Local checkout smoke', description: 'A local selection placeholder for a small checkout regression set.', cases: 0, kind: 'local', updated: 'Created locally' },
]

const evaluatorDefinitions = [
  { id: 'order-state', name: 'Order state invariant', description: 'Checks the final order state independently of the agent claim.', owner: 'Core' },
  { id: 'payment-ledger', name: 'Payment ledger invariant', description: 'Detects duplicate or mismatched settlements in the ledger.', owner: 'Payments' },
  { id: 'timeout-reconciliation', name: 'Timeout reconciliation', description: 'Requires provider-state reconciliation before fulfillment.', owner: 'Payments' },
  { id: 'trace-sufficiency', name: 'Trace sufficiency', description: 'Confirms the report contains enough observable evidence.', owner: 'Evidence' },
]

function readStorage<T>(key: string, fallback: T): T {
  try {
    const value = window.localStorage.getItem(key)
    return value ? (JSON.parse(value) as T) : fallback
  } catch {
    return fallback
  }
}

function writeStorage<T>(key: string, value: T) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Restricted storage should not block the application.
  }
}

function readStoredSession(): Session | null {
  const session = readStorage<Session | null>(sessionStorageKey, null)
  return session?.token && session.user?.email ? session : null
}

function readStoredTheme(): Theme {
  const stored = readStorage<Theme | null>(themeStorageKey, null)
  if (stored === 'light' || stored === 'dark') return stored
  return 'dark'
}

function readStoredDatasets(): LocalDataset[] {
  const stored = readStorage<LocalDataset[] | null>(datasetsStorageKey, null)
  return stored?.length ? stored : defaultDatasets
}

function readStoredProject() {
  try {
    return window.localStorage.getItem(projectStorageKey)
  } catch {
    return null
  }
}

function readStoredEvaluators() {
  const stored = readStorage<string[] | null>(evaluatorStorageKey, null)
  return stored ?? evaluatorDefinitions.map((evaluator) => evaluator.id)
}

function readStoredSettings(): LocalSettings {
  return readStorage<LocalSettings>(settingsStorageKey, { showFixtureHints: true, compactRows: false })
}

function saveStoredProject(projectId: string | null) {
  try {
    if (projectId) window.localStorage.setItem(projectStorageKey, projectId)
    else window.localStorage.removeItem(projectStorageKey)
  } catch {
    // Ignore restricted storage.
  }
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('en-US').format(value)
}

function formatDate(value: string | null) {
  if (!value) return 'Not completed'
  const date = new Date(value)
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function formatScenario(value: string) {
  return scenarioLabels[value as SupportedScenario] ?? value.replaceAll('_', ' ')
}

function formatScore(value: number | null) {
  return value === null ? '—' : `${value}%`
}

const backendRunStates = new Set<RunStatus>([
  'queued',
  'running',
  'cancel_requested',
  'passed',
  'failed',
  'timed_out',
  'inconclusive',
  'cancelled',
])

function normalizeRunState(state: string): RunStatus {
  return backendRunStates.has(state as RunStatus) ? state as RunStatus : 'inconclusive'
}

function displayRunState(run: ApiRun): RunStatus {
  const state = normalizeRunState(run.state)
  return run.cancel_requested && (state === 'queued' || state === 'running') ? 'cancel_requested' : state
}

function humanizeState(state: RunStatus) {
  if (state === 'needs-review') return 'Needs review'
  if (state === 'completed' || state === 'passed') return 'Passed'
  const label = state.replaceAll('_', ' ')
  return label.charAt(0).toUpperCase() + label.slice(1)
}

function durationBetween(start: string | null, end: string | null) {
  if (!start || !end) return null
  const startMs = Date.parse(start)
  const endMs = Date.parse(end)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null
  const milliseconds = endMs - startMs
  if (milliseconds < 1000) return `${milliseconds} ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} s`
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1000)}s`
}

function apiRunDuration(run: ApiRun) {
  const duration = durationBetween(run.started_at, run.completed_at)
  if (duration) return duration
  if (run.started_at) return 'In progress'
  return run.report ? `${run.report.trace.length} trace events` : 'Timing unavailable'
}

function runScore(report: ApiReport | null) {
  if (!report) return null
  const invariants = report.evaluation.invariants
  if (!invariants.length) return report.evaluation.passed ? 100 : 0
  return Math.round((invariants.filter((invariant) => invariant.passed).length / invariants.length) * 100)
}

function apiRunToView(run: ApiRun): Run {
  const report = run.report
  const invariants = report?.evaluation.invariants ?? []
  return {
    id: run.id,
    name: report?.agent_name ?? `${run.agent}-sample-agent`,
    model: report?.agent_name ?? `${run.agent}-sample-agent`,
    modelVersion: report ? 'Persisted report' : 'Report unavailable',
    dataset: formatScenario(run.scenario),
    status: displayRunState(run),
    score: runScore(report),
    scoreDelta: null,
    completedAt: formatDate(run.completed_at ?? run.created_at),
    duration: apiRunDuration(run),
    cases: invariants.length,
    passedCases: invariants.filter((invariant) => invariant.passed).length,
    caseLabel: 'invariants',
    tags: [run.agent, run.scenario],
  }
}

function buildApiStats(runs: ApiRun[]): DashboardStats {
  const reports = runs.map((run) => run.report).filter((report): report is ApiReport => report !== null)
  const passed = reports.filter((report) => report.evaluation.passed).length
  const totalTraces = reports.reduce((total, report) => total + report.trace.length, 0)
  const duplicateCharges = reports.reduce((total, report) => total + report.metrics.duplicate_charges, 0)
  const safeRetests = reports.filter((report) => report.agent_name === 'safe-sample-agent' && report.evaluation.passed).length
  return {
    passRate: reports.length ? `${Math.round((passed / reports.length) * 100)}%` : '—',
    evaluated: reports.length ? `${passed} / ${reports.length} passed` : '—',
    traceCount: reports.length ? formatNumber(totalTraces) : '—',
    duplicateCharges: reports.length ? formatNumber(duplicateCharges) : '—',
    safeRetests: reports.length ? formatNumber(safeRetests) : '—',
  }
}

function buildFixtureStats(): DashboardStats {
  const passed = demoRuns.filter((run) => run.status === 'completed').length
  const traceCount = demoRuns.reduce((total, run) => total + Number.parseInt(run.duration, 10), 0)
  return {
    passRate: `${Math.round((passed / demoRuns.length) * 100)}%`,
    evaluated: `${passed} / ${demoRuns.length} passed`,
    traceCount: formatNumber(traceCount),
    duplicateCharges: '—',
    safeRetests: formatNumber(demoRuns.filter((run) => run.model === 'safe-sample-agent').length),
  }
}

function buildApiCoverage(runs: ApiRun[]): CoverageItem[] {
  const grouped = new Map<string, { passed: number; total: number }>()
  for (const report of runs.map((run) => run.report).filter((item): item is ApiReport => item !== null)) {
    for (const invariant of report.evaluation.invariants) {
      const current = grouped.get(invariant.name) ?? { passed: 0, total: 0 }
      grouped.set(invariant.name, { passed: current.passed + (invariant.passed ? 1 : 0), total: current.total + 1 })
    }
  }
  const colors: CoverageItem['color'][] = ['cyan', 'green', 'violet', 'amber']
  return Array.from(grouped.entries()).map(([label, result], index) => ({
    label,
    value: Math.round((result.passed / result.total) * 100),
    color: colors[index % colors.length],
  }))
}

function buildTrend(runs: Run[]): TrendPoint[] {
  return runs
    .filter((run): run is Run & { score: number } => run.score !== null)
    .reverse()
    .map((run) => ({ label: run.id.slice(0, 10), value: run.score }))
}

function pageForPath(pathname: string): View {
  if (pathname === '/runs') return 'dashboard'
  if (pathname.startsWith('/runs/')) return 'run'
  if (pathname === '/agents') return 'agents'
  if (pathname === '/datasets') return 'datasets'
  if (pathname === '/evaluators') return 'evaluators'
  if (pathname === '/settings') return 'settings'
  if (pathname === '/cli') return 'cli'
  return 'overview'
}

function runIdFromPath(pathname: string) {
  if (!pathname.startsWith('/runs/')) return null
  try {
    return decodeURIComponent(pathname.slice('/runs/'.length)) || null
  } catch {
    return null
  }
}

function StatusBadge({ status }: { status: Run['status'] }) {
  return <span className={`status-badge status-${status}`}><span className="status-dot" />{humanizeState(status)}</span>
}

function SourceBadge({ apiMode, apiStatus }: { apiMode: boolean; apiStatus: ApiStatus }) {
  const label = apiMode ? 'Live API · persisted' : apiStatus === 'offline' ? 'Offline fallback · fixtures' : apiStatus === 'checking' ? 'Checking API' : 'Local fixture mode'
  return <span className={`source-badge ${apiMode ? 'source-live' : ''}`}><span className="source-dot" />{label}</span>
}

function BrandMark() {
  return (
    <span aria-hidden="true" className="brand-mark">
      <svg viewBox="0 0 32 32"><path d="M5 7.5 16 24 27 7.5" /><path d="M9.5 8.5 16 18l6.5-9.5" /><circle cx="5" cy="7.5" r="2" /><circle cx="27" cy="7.5" r="2" /></svg>
    </span>
  )
}

function Workspace() {
  const api = useMemo(() => createApiClient(), [])
  const location = useLocation()
  const navigate = useNavigate()
  const view = pageForPath(location.pathname)
  const selectedRunId = runIdFromPath(location.pathname)
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme())
  const [apiStatus, setApiStatus] = useState<ApiStatus>('checking')
  const [authOpen, setAuthOpen] = useState(false)
  const [session, setSession] = useState<Session | null>(() => readStoredSession())
  const [projects, setProjects] = useState<ApiProject[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() => readStoredProject())
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [projectError, setProjectError] = useState('')
  const [apiAgents, setApiAgents] = useState<ApiAgent[]>([])
  const [apiScenarios, setApiScenarios] = useState<ApiScenario[]>([])
  const [agentsLoading, setAgentsLoading] = useState(false)
  const [agentsError, setAgentsError] = useState('')
  const [agentRegistrationBusy, setAgentRegistrationBusy] = useState(false)
  const [apiRuns, setApiRuns] = useState<ApiRun[]>([])
  const [runsLoading, setRunsLoading] = useState(false)
  const [runError, setRunError] = useState('')
  const [runComposerOpen, setRunComposerOpen] = useState(false)
  const [runBusy, setRunBusy] = useState(false)
  const [runComposerError, setRunComposerError] = useState('')
  const [noticeVisible, setNoticeVisible] = useState(true)
  const [localDatasets, setLocalDatasets] = useState<LocalDataset[]>(() => readStoredDatasets())
  const [enabledEvaluators, setEnabledEvaluators] = useState<string[]>(() => readStoredEvaluators())
  const [localSettings, setLocalSettings] = useState<LocalSettings>(() => readStoredSettings())
  const [sidebarCompact, setSidebarCompact] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)

  const token = session?.token ?? null
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null
  const scenarioOptions = useMemo<ScenarioOption[]>(() => apiScenarios.length
    ? apiScenarios.map((scenario) => ({ value: scenario.id as SupportedScenario, label: scenario.name, description: scenario.description, category: scenario.category, parameters: scenario.parameters, expectedOutcome: scenario.expected_outcome }))
    : scenarios, [apiScenarios])
  const apiMode = apiStatus === 'online' && Boolean(token && selectedProjectId)
  const displayRuns = apiMode ? apiRuns.map(apiRunToView) : demoRuns
  const selectedApiRun = apiRuns.find((run) => run.id === selectedRunId && run.project_id === selectedProjectId) ?? null
  const selectedRun = apiMode ? (selectedApiRun ? apiRunToView(selectedApiRun) : null) : selectedRunId ? demoRuns.find((run) => run.id === selectedRunId) ?? null : null
  const stats = useMemo(() => apiMode ? buildApiStats(apiRuns) : buildFixtureStats(), [apiMode, apiRuns])
  const coverage = apiMode ? buildApiCoverage(apiRuns) : demoCoverage
  const trend = apiMode ? buildTrend(apiRuns.map(apiRunToView)) : buildTrend(demoRuns)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    writeStorage(themeStorageKey, theme)
  }, [theme])

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandPaletteOpen((current) => !current)
      }
    }
    window.addEventListener('keydown', keyboard)
    return () => window.removeEventListener('keydown', keyboard)
  }, [])

  useEffect(() => {
    writeStorage(datasetsStorageKey, localDatasets)
  }, [localDatasets])

  useEffect(() => {
    writeStorage(evaluatorStorageKey, enabledEvaluators)
  }, [enabledEvaluators])

  useEffect(() => {
    writeStorage(settingsStorageKey, localSettings)
  }, [localSettings])

  useEffect(() => {
    let active = true
    api.getHealth().then(() => active && setApiStatus('online')).catch(() => active && setApiStatus('offline'))
    return () => { active = false }
  }, [api])

  useEffect(() => {
    let active = true
    if (!token) {
      setProjects([])
      setSelectedProjectId(null)
      saveStoredProject(null)
      setApiAgents([])
      setApiScenarios([])
      setApiRuns([])
      return
    }
    setProjectsLoading(true)
    setProjectError('')
    api.listProjects(token).then((nextProjects) => {
      if (!active) return
      setProjects(nextProjects)
      setSelectedProjectId((current) => {
        const nextId = current && nextProjects.some((project) => project.id === current) ? current : nextProjects[0]?.id ?? null
        saveStoredProject(nextId)
        return nextId
      })
    }).catch((error: unknown) => {
      if (active) setProjectError(error instanceof Error ? error.message : 'Could not load projects.')
    }).finally(() => active && setProjectsLoading(false))
    return () => { active = false }
  }, [api, token])

  useEffect(() => {
    let active = true
    if (!token || apiStatus !== 'online') {
      setApiScenarios([])
      return
    }
    api.listScenarios(token).then((catalog) => active && setApiScenarios(catalog)).catch(() => active && setApiScenarios([]))
    return () => { active = false }
  }, [api, apiStatus, token])

  useEffect(() => {
    let active = true
    if (!token || !selectedProjectId || apiStatus !== 'online') {
      setApiAgents([])
      setAgentsError('')
      setAgentsLoading(false)
      return
    }
    setAgentsLoading(true)
    setAgentsError('')
    api.listAgents(token, selectedProjectId).then((agents) => {
      if (active) setApiAgents(agents)
    }).catch((error: unknown) => {
      if (active) setAgentsError(error instanceof Error ? error.message : 'Could not load project agents.')
    }).finally(() => active && setAgentsLoading(false))
    return () => { active = false }
  }, [api, apiStatus, selectedProjectId, token])

  useEffect(() => {
    let active = true
    if (!token || !selectedProjectId) {
      setApiRuns([])
      setRunError('')
      setRunsLoading(false)
      return
    }
    setRunsLoading(true)
    setRunError('')
    api.listProjectRuns(token, selectedProjectId).then(async (summaries) => {
      const details = await Promise.all(summaries.map((summary) => api.getApiRun(token, summary.id)))
      if (active) setApiRuns(details)
    }).catch((error: unknown) => {
      if (active) setRunError(error instanceof Error ? error.message : 'Could not load persisted runs.')
    }).finally(() => active && setRunsLoading(false))
    return () => { active = false }
  }, [api, selectedProjectId, token])

  useEffect(() => {
    if (!apiMode || view !== 'run' || !selectedRunId || !token || !selectedProjectId || selectedApiRun) return
    let active = true
    setRunsLoading(true)
    api.getApiRun(token, selectedRunId).then((run) => {
      if (active) setApiRuns((current) => [run, ...current.filter((item) => item.id !== run.id)])
    }).catch((error: unknown) => {
      if (active) setRunError(error instanceof Error ? error.message : 'Could not load this persisted run.')
    }).finally(() => active && setRunsLoading(false))
    return () => { active = false }
  }, [api, apiMode, selectedApiRun, selectedProjectId, selectedRunId, token, view])

  const setSignedIn = (nextSession: Session) => {
    writeStorage(sessionStorageKey, nextSession)
    setSession(nextSession)
    setAuthOpen(false)
  }

  const signOut = async () => {
    if (token) {
      try { await api.logout(token) } catch { /* Local session cleanup still applies. */ }
    }
    try { window.localStorage.removeItem(sessionStorageKey) } catch { /* Ignore restricted storage. */ }
    setSession(null)
    setProjects([])
    setApiRuns([])
    navigate('/')
  }

  const selectProject = (projectId: string) => {
    setApiRuns([])
    setRunError('')
    setSelectedProjectId(projectId || null)
    saveStoredProject(projectId || null)
    setRunComposerOpen(false)
    navigate('/runs')
  }

  const createProject = async (name: string, description: string) => {
    if (!token) return
    setProjectError('')
    try {
      const project = await api.createProject(token, name, description)
      setProjects((current) => [project, ...current])
      setSelectedProjectId(project.id)
      saveStoredProject(project.id)
      navigate('/runs')
    } catch (error: unknown) {
      setProjectError(error instanceof Error ? error.message : 'Could not create the project.')
      throw error
    }
  }

  const requestRun = () => {
    if (!session) { setAuthOpen(true); return }
    if (!selectedProjectId) { setProjectError('Create or select a project before starting a persisted run.'); navigate('/runs'); return }
    setRunComposerError('')
    setRunComposerOpen(true)
    navigate('/runs')
  }

  const submitRun = async (agent: SupportedAgent, scenario: SupportedScenario, options?: { seed?: number; parameters?: Record<string, string | number | boolean | null> }) => {
    if (!token || !selectedProjectId) return
    setRunBusy(true)
    setRunComposerError('')
    try {
      const created = await api.createRun(token, selectedProjectId, agent, scenario, options)
      setApiRuns((current) => [created, ...current.filter((run) => run.id !== created.id)])
      setRunComposerOpen(false)
      navigate(`/runs/${encodeURIComponent(created.id)}`)
    } catch (error: unknown) {
      setRunComposerError(error instanceof Error ? error.message : 'The API could not persist this run.')
    } finally {
      setRunBusy(false)
    }
  }

  const registerAgent = async (name: string, version: string, source: string) => {
    if (!token || !selectedProjectId) throw new Error('Sign in and select a project before registering an agent.')
    setAgentRegistrationBusy(true)
    try {
      const registered = await api.registerAgent(token, selectedProjectId, name, version, source)
      setApiAgents((current) => [registered, ...current])
    } finally {
      setAgentRegistrationBusy(false)
    }
  }

  const importGithubAgent = async (name: string, version: string, repositoryUrl: string, ref: string, entrypoint: string) => {
    if (!token || !selectedProjectId) throw new Error('Sign in and select a project before importing an agent.')
    setAgentRegistrationBusy(true)
    try {
      const imported = await api.importGithubAgent(token, selectedProjectId, name, version, repositoryUrl, ref, entrypoint)
      setApiAgents((current) => [imported, ...current])
    } finally {
      setAgentRegistrationBusy(false)
    }
  }

  const setView = (nextView: View) => {
    const item = navItems.find((navItem) => navItem.id === nextView)
    navigate(item?.path ?? '/')
  }

  const openRun = (runId: string) => navigate(`/runs/${encodeURIComponent(runId)}`)
  const updateLocalSettings = (next: Partial<LocalSettings>) => setLocalSettings((current) => ({ ...current, ...next }))
  const resetLocalConfig = () => {
    setLocalDatasets(defaultDatasets)
    setEnabledEvaluators(evaluatorDefinitions.map((evaluator) => evaluator.id))
    setLocalSettings({ showFixtureHints: true, compactRows: false })
  }

  const commands: WorkspaceCommand[] = [
    ...navItems.map((item) => ({ id: item.id, label: item.label, detail: 'Navigate to page', icon: item.icon, run: () => setView(item.id) })),
    { id: 'new-evaluation', label: 'New evaluation', detail: 'Configure and persist an agent run', icon: 'play', run: requestRun },
    ...displayRuns.map((run) => ({ id: run.id, label: run.name, detail: `${run.id} · ${run.dataset}`, icon: 'activity' as const, run: () => openRun(run.id) })),
  ]

  return (
    <div className={`app-shell ${sidebarCompact ? 'sidebar-is-compact' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-top">
          <button className="brand-lockup" onClick={() => navigate('/')} type="button">
            <BrandMark /><span className="brand-name">verity<span>bench</span></span>
          </button>
          <span className="brand-version">v0.1</span>
        </div>
        <div className="workspace-switcher">
          <span className="workspace-avatar">{selectedProject?.name.slice(0, 1).toUpperCase() ?? 'V'}</span>
          <span className="workspace-copy"><span className="workspace-label">Workspace</span><strong>{selectedProject?.name ?? 'Local explorer'}</strong></span>
          <Icon name="chevron-down" size={15} />
        </div>
        <button aria-label="Search workspace" className="sidebar-search" onClick={() => setCommandPaletteOpen(true)} type="button"><Icon name="search" size={15} /><span>Search workspace</span><kbd>⌘ K</kbd></button>
        <nav aria-label="Main navigation" className="main-nav">
          <span className="nav-section-label">Observability</span>
          {navItems.slice(0, 2).map((item) => <NavItem active={view === item.id || (view === 'run' && item.id === 'dashboard')} count={item.id === 'dashboard' ? displayRuns.length : undefined} item={item} key={item.id} onNavigate={setView} />)}
          <span className="nav-section-label nav-section-spaced">Workspace</span>
          {navItems.slice(2, 7).map((item) => <NavItem active={view === item.id} item={item} key={item.id} onNavigate={setView} />)}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note"><span className="note-mark" /><span><strong>{apiMode ? 'Connected workspace' : 'Local-first preview'}</strong><small>{apiMode ? 'Protected API data' : 'Fixtures stay in your browser'}</small></span></div>
          <div className="user-row">
            <span className="user-avatar">{session ? session.user.email.slice(0, 2).toUpperCase() : 'DE'}</span>
            <span className="user-copy"><strong>{session?.user.email ?? 'Demo explorer'}</strong><span>{session ? 'Authenticated' : 'Offline mode'}</span></span>
            {session ? <button aria-label="Sign out" className="icon-button subtle-icon" onClick={signOut} type="button"><Icon name="more" size={18} /></button> : <button aria-label="Sign in" className="icon-button subtle-icon" onClick={() => setAuthOpen(true)} type="button"><Icon name="arrow-up-right" size={16} /></button>}
          </div>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="topbar-context"><button aria-label={sidebarCompact ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!sidebarCompact} className="icon-button sidebar-toggle" onClick={() => setSidebarCompact((current) => !current)} type="button"><Icon name="menu" size={17} /></button><div className="breadcrumbs" aria-label="Breadcrumb"><span>{selectedProject?.name ?? 'Local workspace'}</span><span className="breadcrumb-separator">/</span><strong>{viewLabels[view]}</strong></div></div>
          <div className="topbar-actions">
            <SourceBadge apiMode={apiMode} apiStatus={apiStatus} />
            <button aria-label="Search workspace" className="icon-button topbar-search" onClick={() => setCommandPaletteOpen(true)} type="button"><Icon name="search" size={16} /></button>
            <button aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`} className="theme-toggle" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} type="button"><Icon name={theme === 'light' ? 'moon' : 'sun'} size={16} /><span>{theme === 'light' ? 'Dark' : 'Light'}</span></button>
            <button aria-label={session ? `Sign out ${session.user.email}` : 'Sign in'} className="topbar-avatar profile-button" onClick={session ? signOut : () => setAuthOpen(true)} type="button">{session ? session.user.email.slice(0, 2).toUpperCase() : 'SI'}</button>
          </div>
        </header>

        <AgentCatalogContext.Provider value={apiMode ? apiAgents : localRunAgents}>
        <main className="page-content">
          <ProjectBar apiStatus={apiStatus} error={projectError} loading={projectsLoading} onCreate={createProject} onOpenAuth={() => setAuthOpen(true)} onSelect={selectProject} projects={projects} selectedProjectId={selectedProjectId} session={session} />
          {noticeVisible && localSettings.showFixtureHints && <div className={`data-notice ${apiMode ? 'data-notice-live' : ''}`}><Icon name={apiMode ? 'shield' : 'layers'} size={16} /><span><strong>{apiMode ? 'Live project data' : apiStatus === 'offline' ? 'API unavailable · offline fallback' : 'Local fixture mode'}</strong>{' · '}{apiMode ? 'Runs, metrics, reports, and evidence are loaded from the selected project.' : 'Read-only fixtures are labeled throughout; no local action writes to the API.'}</span><button aria-label="Dismiss data source notice" className="notice-dismiss" onClick={() => setNoticeVisible(false)} type="button">×</button></div>}
          {runError && apiMode && <div className="inline-error" role="alert">{runError}</div>}
          {(view === 'overview' || view === 'dashboard') && <ObservabilityDashboard apiData={apiMode} apiRuns={apiRuns} compactRows={localSettings.compactRows} composer={view === 'dashboard' && runComposerOpen ? <RunComposer busy={runBusy} error={runComposerError} onCancel={() => setRunComposerOpen(false)} onSubmit={submitRun} scenarioOptions={scenarioOptions} /> : undefined} coverage={coverage} onNavigate={setView} onOpenRun={openRun} onRun={requestRun} overview={view === 'overview'} runs={displayRuns} stats={stats} />}
           {view === 'run' && <RunDetail api={api} apiRun={apiMode ? selectedApiRun : null} loading={apiMode && runsLoading && !selectedApiRun} onBack={() => setView('dashboard')} onRunUpdated={(nextRun) => setApiRuns((current) => [nextRun, ...current.filter((run) => run.id !== nextRun.id)])} run={selectedRun} token={token} />}
            {view === 'agents' && <AgentsPage agents={apiAgents} apiData={apiMode} error={agentsError} loading={agentsLoading} onBrowseRuns={() => setView('dashboard')} onOpenCli={() => setView('cli')} onRegister={registerAgent} onImportGithub={importGithubAgent} registrationBusy={agentRegistrationBusy} onRetry={() => { if (token && selectedProjectId) { setAgentsLoading(true); api.listAgents(token, selectedProjectId).then(setApiAgents).catch((error: unknown) => setAgentsError(error instanceof Error ? error.message : 'Could not load project agents.')).finally(() => setAgentsLoading(false)) } }} />}
          {view === 'datasets' && <DatasetsPage datasets={localDatasets} onAdd={(dataset) => setLocalDatasets((current) => [...current, dataset])} onSelect={setView} />}
          {view === 'evaluators' && <EvaluatorsPage enabled={enabledEvaluators} onToggle={(id) => setEnabledEvaluators((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])} />}
          {view === 'settings' && <SettingsPage apiStatus={apiStatus} enabledEvaluators={enabledEvaluators.length} localSettings={localSettings} onCheck={() => { setApiStatus('checking'); api.getHealth().then(() => setApiStatus('online')).catch(() => setApiStatus('offline')) }} onReset={resetLocalConfig} onSettingsChange={updateLocalSettings} onThemeChange={setTheme} session={session} theme={theme} />}
          {view === 'cli' && <CliGuide />}
        </main>
        </AgentCatalogContext.Provider>
      </div>
      {authOpen && <AuthPanel api={api} onClose={() => setAuthOpen(false)} onSignedIn={setSignedIn} />}
      {commandPaletteOpen && <CommandPalette commands={commands} onClose={() => setCommandPaletteOpen(false)} />}
    </div>
  )
}

function NavItem({ active, count, item, onNavigate }: { active: boolean; count?: number; item: typeof navItems[number]; onNavigate: (view: View) => void }) {
  return <button aria-current={active ? 'page' : undefined} aria-label={item.label} className={`nav-item ${active ? 'is-active' : ''}`} onClick={() => onNavigate(item.id)} title={item.label} type="button"><Icon name={item.icon} size={17} /><span className="nav-label">{item.label}</span>{count !== undefined && <span className="nav-count">{String(count).padStart(2, '0')}</span>}</button>
}

function ProjectBar({ apiStatus, error, loading, onCreate, onOpenAuth, onSelect, projects, selectedProjectId, session }: { apiStatus: ApiStatus; error: string; loading: boolean; onCreate: (name: string, description: string) => Promise<void>; onOpenAuth: () => void; onSelect: (projectId: string) => void; projects: ApiProject[]; selectedProjectId: string | null; session: Session | null }) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true)
    try { await onCreate(name, description); setName(''); setDescription(''); setCreating(false) } catch { /* Parent shows the error. */ } finally { setBusy(false) }
  }
  return <section aria-label="Project workspace" className="project-bar"><div className="project-bar-copy"><span className="section-kicker">Project context</span><strong>{session ? selectedProjectId ? 'Persisted evaluation project' : 'Choose a project to begin' : 'Browsing local fixtures'}</strong><span>{session ? 'Protected runs are scoped to the selected project.' : 'Sign in when you want to create and persist a run.'}</span></div>{!session ? <button className="button button-secondary" onClick={onOpenAuth} type="button"><Icon name="shield" size={14} /> Sign in for API access</button> : creating ? <form className="project-create-form" onSubmit={submit}><input aria-label="Project name" onChange={(event) => setName(event.target.value)} placeholder="Project name" required value={name} /><input aria-label="Project description" onChange={(event) => setDescription(event.target.value)} placeholder="Description (optional)" value={description} /><button className="button button-primary" disabled={busy || apiStatus !== 'online'} type="submit">{busy ? 'Creating…' : 'Create'}</button><button className="button button-quiet" onClick={() => setCreating(false)} type="button">Cancel</button></form> : <div className="project-bar-actions"><label className="project-select-label"><span className="sr-only">Selected project</span><select disabled={loading || !projects.length} onChange={(event) => onSelect(event.target.value)} value={selectedProjectId ?? ''}>{!projects.length && <option value="">{loading ? 'Loading projects…' : 'No projects yet'}</option>}{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><Icon name="chevron-down" size={14} /></label><button className="button button-secondary" disabled={apiStatus !== 'online'} onClick={() => setCreating(true)} type="button"><Icon name="file-plus" size={14} /> New project</button></div>}{error && <span className="project-error" role="alert">{error}</span>}</section>
}

function AuthPanel({ api, onClose, onSignedIn }: { api: ApiClient; onClose: () => void; onSignedIn: (session: Session) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const result = mode === 'login' ? await api.login(email, password) : await api.register(email, password)
      onSignedIn({ token: result.access_token, user: result.user })
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'The API could not authenticate this account.')
    } finally { setBusy(false) }
  }
  return <div className="auth-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section aria-labelledby="auth-title" aria-modal="true" className="auth-panel" role="dialog"><button aria-label="Close authentication dialog" className="auth-close" onClick={onClose} type="button">×</button><span className="eyebrow"><Icon name="shield" size={14} /> Protected workspace</span><h2 id="auth-title">{mode === 'login' ? 'Sign in to VerityBench' : 'Create your workspace'}</h2><p className="auth-description">Projects and reports are authorized server-side. The sample agents never receive your credentials.</p><form onSubmit={submit}><label>Email<input autoComplete="email" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} /></label><label>Password<input autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={12} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></label>{error && <p className="auth-error" role="alert">{error}</p>}<button className="button button-primary auth-submit" disabled={busy} type="submit">{busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Register'}</button></form><button className="auth-switch" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError('') }} type="button">{mode === 'login' ? 'Need an account? Register' : 'Already registered? Sign in'}</button></section></div>
}

function PageIntro({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-intro"><div><span className="eyebrow"><span className="eyebrow-line" />{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action}</div>
}

function Overview({ apiData, coverage, onNavigate, onOpenRun, onRun, runs, stats, trend }: { apiData: boolean; coverage: CoverageItem[]; onNavigate: (view: View) => void; onOpenRun: (id: string) => void; onRun: () => void; runs: Run[]; stats: DashboardStats; trend: TrendPoint[] }) {
  const latest = runs[0]
  return <>
    <PageIntro eyebrow="Evidence-first evaluation" title="Know what your agent actually did." description="Run controlled scenarios, inspect the trace and ledger, and keep reliability claims tied to observable evidence." action={<button className="button button-primary" onClick={onRun} type="button"><Icon name="play" size={14} /> {apiData ? 'Start a run' : 'View sample run'}</button>} />
    <section className="overview-hero"><div className="hero-copy"><div className="hero-chip"><span className="hero-chip-dot" />{apiData ? 'Selected project signal' : 'Read-only fixture snapshot'}</div><h2>{apiData ? 'Your project, in plain view.' : 'A reliable workflow starts with a falsifiable report.'}</h2><p>{apiData ? 'The summary below is calculated from persisted API reports. Open any run to see the exact invariant evidence behind the score.' : 'The local sample shows the same inspection path without pretending to be backend data. Sign in to create a project and persist new runs.'}</p><div className="hero-links"><button className="text-button" onClick={() => onNavigate('dashboard')} type="button">Browse agent runs <Icon name="arrow-right" size={15} /></button><button className="text-button text-button-muted" onClick={() => onNavigate('cli')} type="button">Use the API guide <Icon name="arrow-up-right" size={15} /></button></div></div><PulseSummary apiData={apiData} latest={latest} stats={stats} trend={trend} /></section>
    <div className="section-heading"><div><span className="section-kicker">At a glance</span><h2>Signals from the current source</h2></div><span className="muted-label">{apiData ? 'Derived from persisted reports' : 'Derived from local fixtures'}</span></div>
    <div className="metric-grid"><MetricCard label="Evaluation pass rate" value={stats.passRate} detail={stats.evaluated} icon="gauge" tone="accent" /><MetricCard label="Recorded traces" value={stats.traceCount} detail={apiData ? 'Events in persisted reports' : 'Events in fixture runs'} icon="activity" tone="violet" /><MetricCard label="Duplicate charges" value={stats.duplicateCharges} detail={apiData ? 'Report metric total' : 'Not in fixture metadata'} icon="shield" tone="green" /></div>
    <div className="overview-columns"><RecentRuns apiData={apiData} onOpenRun={onOpenRun} runs={runs} /><CoveragePanel apiData={apiData} items={coverage} /></div>
    <section className="insight-strip"><span className="insight-icon"><Icon name={apiData ? 'shield' : 'layers'} size={18} /></span><div><span className="section-kicker">Next useful step</span><h3>{apiData ? latest ? 'Inspect the latest persisted report.' : 'Create the first persisted report.' : 'Inspect how evidence catches the defect.'}</h3><p>{apiData ? latest ? 'Open the run detail to review invariants, findings, ledger entries, and trace events.' : 'Choose a sample agent and scenario from Agent runs.' : 'The local defective fixture includes a duplicate-charge signal and its evidence.'}</p></div><button className="text-button" onClick={apiData ? latest ? () => onOpenRun(latest.id) : onRun : () => runs[2] && onOpenRun(runs[2].id)} type="button">{apiData ? latest ? 'Open report' : 'Run sample agent' : 'Open evidence'} <Icon name="arrow-right" size={15} /></button></section>
  </>
}

function PulseSummary({ apiData, latest, stats, trend }: { apiData: boolean; latest?: Run; stats: DashboardStats; trend: TrendPoint[] }) {
  const lastPoint = trend[trend.length - 1]
  return <section className="pulse-summary"><div className="pulse-header"><span className="card-label"><span className="live-dot" />{apiData ? 'Persisted project score' : 'Fixture score'}</span><span className="muted-label">{trend.length ? `${trend.length} points` : 'No report score'}</span></div><strong className="pulse-number">{lastPoint ? lastPoint.value : stats.passRate === '—' ? '—' : stats.passRate.replace('%', '')}<small>{lastPoint || stats.passRate !== '—' ? '%' : ''}</small></strong><span className="pulse-label">{latest ? `${latest.name} · ${latest.dataset}` : apiData ? 'No persisted run selected' : 'Local deterministic snapshot'}</span><MiniTrend points={trend} /><div className="pulse-footer"><span><Icon name="check" size={13} /> Score only, no invented baseline</span><span>{apiData ? 'API report history' : 'Fixture history'}</span></div></section>
}

function MiniTrend({ points }: { points: TrendPoint[] }) {
  if (!points.length) return <div className="mini-trend-empty">Run a scenario to plot report scores.</div>
  const coordinates = points.map((point, index) => `${(index / Math.max(1, points.length - 1)) * 100},${100 - point.value}`).join(' ')
  return <div aria-label="Report score trend" className="mini-trend" role="img"><svg preserveAspectRatio="none" viewBox="0 0 100 100"><line x1="0" x2="100" y1="25" y2="25" /><line x1="0" x2="100" y1="50" y2="50" /><line x1="0" x2="100" y1="75" y2="75" /><polyline points={coordinates} /></svg></div>
}

function MetricCard({ label, value, detail, icon, tone }: { label: string; value: string; detail: string; icon: IconName; tone: string }) {
  return <article className="metric-card"><div className={`metric-icon metric-icon-${tone}`}><Icon name={icon} size={18} /></div><span className="metric-label">{label}</span><strong className="metric-value">{value}</strong><span className="metric-detail">{detail}</span></article>
}

function RecentRuns({ apiData, onOpenRun, runs }: { apiData: boolean; onOpenRun: (id: string) => void; runs: Run[] }) {
  return <section className="panel recent-panel"><div className="panel-heading"><div><span className="section-kicker">Activity</span><h2>{apiData ? 'Persisted runs' : 'Fixture runs'}</h2></div><span className="muted-label">{runs.length} total</span></div><div className="run-list">{runs.length ? runs.slice(0, 4).map((run) => <RunRow key={run.id} onOpen={onOpenRun} run={run} />) : <EmptyPanel description="No persisted reports are available for this project yet." />}</div><button className="panel-footer-button" onClick={() => runs.length && onOpenRun(runs[0].id)} type="button">Open run history <Icon name="arrow-right" size={15} /></button></section>
}

function RunRow({ onOpen, run }: { onOpen: (id: string) => void; run: Run }) {
  const attention = run.status === 'needs-review' || run.status === 'failed' || run.status === 'timed_out' || run.status === 'inconclusive' || run.status === 'cancelled'
  return <button className={`run-row ${attention ? 'run-row-needs-review' : ''}`} onClick={() => onOpen(run.id)} type="button"><span className="run-type-icon"><Icon name={attention ? 'warning' : 'activity'} size={16} /></span><span className="run-row-copy"><strong>{run.name}</strong><span>{run.id} · {run.dataset}</span></span><span className="run-row-score"><strong>{formatScore(run.score)}</strong><span>{run.score === null ? 'no report' : `${run.passedCases}/${run.cases} ${run.caseLabel ?? 'cases'}`}</span></span><Icon name="chevron-right" size={16} className="row-chevron" /></button>
}

function CoveragePanel({ apiData, items }: { apiData: boolean; items: CoverageItem[] }) {
  return <section className="panel coverage-panel"><div className="panel-heading"><div><span className="section-kicker">Evaluator coverage</span><h2>{apiData ? 'Persisted invariant signals' : 'Fixture invariant signals'}</h2></div><span className="muted-label">{items.length} signals</span></div><div className="coverage-list">{items.length ? items.map((item) => <CoverageBar item={item} key={item.label} />) : <EmptyPanel description="Coverage appears after the first persisted report." />}</div><div className="coverage-note"><Icon name="shield" size={15} /><span>{apiData ? 'Grouped from report.evaluation.invariants.' : 'Read-only values from repository-owned fixtures.'}</span></div></section>
}

function CoverageBar({ item }: { item: CoverageItem }) {
  return <div className="coverage-row"><div className="coverage-label"><span>{item.label}</span><strong>{item.value}%</strong></div><div aria-label={`${item.label}: ${item.value} percent`} aria-valuemax={100} aria-valuemin={0} aria-valuenow={item.value} className="progress-track" role="progressbar"><span className={`progress-fill fill-${item.color}`} style={{ width: `${item.value}%` }} /></div></div>
}

function Dashboard({ agents, apiData, apiRuns, composerOpen, compactRows, onCancelRun, onOpenRun, onRun, onSubmitRun, runBusy, runComposerError, runs, stats, trend }: { agents: ApiAgent[]; apiData: boolean; apiRuns: ApiRun[]; composerOpen: boolean; compactRows: boolean; onCancelRun: () => void; onOpenRun: (id: string) => void; onRun: () => void; onSubmitRun: (agent: SupportedAgent, scenario: SupportedScenario) => Promise<void>; runBusy: boolean; runComposerError: string; runs: Run[]; stats: DashboardStats; trend: TrendPoint[] }) {
  const [filter, setFilter] = useState<'all' | Run['status']>('all')
  const [query, setQuery] = useState('')
  const filteredRuns = runs.filter((run) => (filter === 'all' || run.status === filter) && `${run.name} ${run.dataset} ${run.id}`.toLowerCase().includes(query.toLowerCase()))
  return <><PageIntro eyebrow="Evaluation history" title="Agent runs" description="Replay controlled scenarios and inspect the evidence behind every outcome." action={<button className="button button-primary" onClick={onRun} type="button"><Icon name="play" size={14} /> Run sample agent</button>} />{composerOpen && <RunComposer busy={runBusy} error={runComposerError} onCancel={onCancelRun} onSubmit={onSubmitRun} />}<div className="metric-grid dashboard-metrics"><MetricCard label="Evaluation pass rate" value={stats.passRate} detail={stats.evaluated} icon="gauge" tone="accent" /><MetricCard label="Recorded traces" value={stats.traceCount} detail={apiData ? 'From persisted reports' : 'From fixtures'} icon="activity" tone="violet" /><MetricCard label="Duplicate charges" value={stats.duplicateCharges} detail={apiData ? 'Report metric total' : 'Not in fixture metadata'} icon="warning" tone="amber" /><MetricCard label="Safe retests" value={stats.safeRetests} detail={apiData ? 'Passed safe reports' : 'Fixture runs'} icon="check" tone="green" /></div><div className="dashboard-grid"><TrendPanel apiData={apiData} points={trend} /><AgentComparison apiData={apiData} runs={apiRuns} /></div><section className="panel runs-table-panel"><div className="panel-heading table-heading"><div><span className="section-kicker">{apiData ? 'Authenticated project' : 'Deterministic sample suite'}</span><h2>{apiData ? 'Persisted agent runs' : 'Fixture run history'}</h2></div><span className="muted-label">{filteredRuns.length} of {runs.length}</span></div><div className="table-toolbar"><label className="search-field"><Icon name="search" size={15} /><span className="sr-only">Filter runs</span><input onChange={(event) => setQuery(event.target.value)} placeholder="Filter by run, dataset, or id" value={query} /></label><div className="filter-group" aria-label="Run status filter">{(['all', 'completed', 'needs-review', 'running'] as const).map((value) => <button className={filter === value ? 'filter-active' : ''} key={value} onClick={() => setFilter(value)} type="button">{value === 'all' ? 'All' : value === 'needs-review' ? 'Needs review' : value === 'completed' ? 'Passed' : 'Running'}</button>)}</div></div><div className="runs-table-wrap"><table className="runs-table"><thead><tr><th>Run</th><th>Agent</th><th>Scenario</th><th>Status</th><th>Score</th><th>Completed</th><th><span className="sr-only">Open</span></th></tr></thead><tbody>{filteredRuns.length ? filteredRuns.map((run) => <tr className={compactRows ? 'compact-row' : ''} key={run.id} onClick={() => onOpenRun(run.id)}><td><button className="table-run-name" onClick={(event) => { event.stopPropagation(); onOpenRun(run.id) }} type="button"><span className="table-run-icon"><Icon name="activity" size={14} /></span><span><strong>{run.name}</strong><small>{run.id}</small></span></button></td><td>{run.model}<small>{run.modelVersion}</small></td><td>{run.dataset}</td><td><StatusBadge status={run.status} /></td><td><strong className="table-score">{formatScore(run.score)}</strong><small>{run.score === null ? 'report unavailable' : `${run.passedCases}/${run.cases} ${run.caseLabel ?? 'cases'}`}</small></td><td className="muted-cell">{run.completedAt}</td><td><button aria-label={`Open ${run.name}`} className="icon-button subtle-icon" onClick={(event) => { event.stopPropagation(); onOpenRun(run.id) }} type="button"><Icon name="chevron-right" size={16} /></button></td></tr>) : <tr><td className="table-empty" colSpan={7}><EmptyPanel description={apiData ? 'No persisted runs match this filter.' : 'No local fixtures match this filter.'} /></td></tr>}</tbody></table></div></section></>
}

function RunComposer({ busy, error, onCancel, onSubmit, scenarioOptions = scenarios }: { busy: boolean; error: string; onCancel: () => void; onSubmit: (agent: SupportedAgent, scenario: SupportedScenario, options?: { seed?: number; parameters?: Record<string, string | number | boolean | null> }) => Promise<void>; scenarioOptions?: ScenarioOption[] }) {
  const agents = useContext(AgentCatalogContext)
  const [agent, setAgent] = useState<SupportedAgent>(agents.find((item) => item.runnable)?.key ?? 'safe')
  const [scenario, setScenario] = useState<SupportedScenario>('normal')
  const [seed, setSeed] = useState(0)
  const [parameterValues, setParameterValues] = useState<Record<string, string | number | boolean | null>>({})
  const selectedAgent = agents.find((item) => item.key === agent)
  const availableScenarios = scenarioOptions.filter((item) => selectedAgent?.supported_scenarios.includes(item.value) ?? true)
  const selectedScenario = availableScenarios.find((item) => item.value === scenario) ?? availableScenarios[0]
  useEffect(() => {
    if (!agents.some((item) => item.key === agent && item.runnable)) {
      setAgent(agents.find((item) => item.runnable)?.key ?? 'safe')
    }
  }, [agent, agents])
  useEffect(() => {
    if (selectedScenario && scenario !== selectedScenario.value) setScenario(selectedScenario.value)
  }, [scenario, selectedScenario])
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void onSubmit(agent, scenario, { seed, parameters: parameterValues }) }
  const setParameter = (name: string, value: string, type: NonNullable<ScenarioOption['parameters']>[number]['type']) => {
    const parsed = type === 'integer' ? Number.parseInt(value, 10) : type === 'number' ? Number(value) : type === 'boolean' ? value === 'true' : value
    setParameterValues((current) => ({ ...current, [name]: parsed }))
  }
  return <section className="panel run-composer"><div className="panel-heading"><div><span className="section-kicker">Protected evaluation execution</span><h2>Configure a persisted run</h2></div><button aria-label="Close run controls" className="icon-button subtle-icon" onClick={onCancel} type="button">×</button></div><p className="composer-description">Select an enabled registered agent and a scenario. Remote agents require the separately configured isolated worker; the API never imports their source.</p><form className="composer-form" onSubmit={submit}><label>Agent<select onChange={(event) => setAgent(event.target.value)} value={agent}>{agents.filter((item) => item.runnable).map((item) => <option key={item.key} value={item.key}>{item.name}{item.version ? ` v${item.version}` : ''} · {item.source}</option>)}</select></label><label>Scenario<select onChange={(event) => { setScenario(event.target.value as SupportedScenario); setParameterValues({}) }} value={scenario}>{availableScenarios.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select><span className="field-help">{selectedScenario?.description}{selectedScenario?.category ? ` · ${selectedScenario.category}` : ''}</span></label><label>Seed<input min="0" onChange={(event) => setSeed(Number(event.target.value))} type="number" value={seed} /></label>{selectedScenario?.parameters?.map((parameter) => <label key={parameter.name}>{parameter.label}<input defaultValue={parameter.default == null ? '' : String(parameter.default)} max={parameter.maximum} min={parameter.minimum} onChange={(event) => setParameter(parameter.name, event.target.value, parameter.type)} type={parameter.type === 'string' ? 'text' : 'number'} /><span className="field-help">{parameter.description}</span></label>)}<div className="composer-actions"><button className="button button-primary" disabled={busy || !selectedAgent?.runnable} type="submit"><Icon name="play" size={14} /> {busy ? 'Running…' : 'Run and persist report'}</button><button className="button button-quiet" onClick={onCancel} type="button">Cancel</button></div></form>{error && <p className="auth-error" role="alert">{error}</p>}</section>
}

function LegacyRunComposer({ busy, error, onCancel, onSubmit }: { busy: boolean; error: string; onCancel: () => void; onSubmit: (agent: SupportedAgent, scenario: SupportedScenario) => Promise<void> }) {
  const [agent, setAgent] = useState<SupportedAgent>('safe')
  const [scenario, setScenario] = useState<SupportedScenario>('normal')
  const selectedScenario = scenarios.find((item) => item.value === scenario)
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void onSubmit(agent, scenario) }
  return <section className="panel run-composer"><div className="panel-heading"><div><span className="section-kicker">Protected sample execution</span><h2>Configure a persisted run</h2></div><button aria-label="Close run controls" className="icon-button subtle-icon" onClick={onCancel} type="button">×</button></div><p className="composer-description">Only the repository-owned sample agents can execute. The selected scenario and evidence report are persisted to the chosen project.</p><form className="composer-form" onSubmit={submit}><label>Agent<select onChange={(event) => setAgent(event.target.value as SupportedAgent)} value={agent}><option value="safe">safe-sample-agent · reconciles uncertainty</option><option value="defective">defective-sample-agent · demonstrates duplicate charge</option></select></label><label>Scenario<select onChange={(event) => setScenario(event.target.value as SupportedScenario)} value={scenario}>{scenarios.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select><span className="field-help">{selectedScenario?.description}</span></label><div className="composer-actions"><button className="button button-primary" disabled={busy} type="submit"><Icon name="play" size={14} /> {busy ? 'Running…' : 'Run and persist report'}</button><button className="button button-quiet" onClick={onCancel} type="button">Cancel</button></div></form>{error && <p className="auth-error" role="alert">{error}</p>}</section>
}

function TrendPanel({ apiData, points }: { apiData: boolean; points: TrendPoint[] }) {
  return <section className="panel trend-panel"><div className="panel-heading"><div><span className="section-kicker">{apiData ? 'Persisted report history' : 'Fixture history'}</span><h2>Score trend</h2></div><span className="muted-label">{points.length ? `${points.length} scored runs` : 'No scored runs'}</span></div><ScoreChart points={points} /></section>
}

function ScoreChart({ points }: { points: TrendPoint[] }) {
  if (!points.length) return <EmptyPanel description="Run a sample agent to build persisted evaluation history." />
  const coordinates = points.map((point, index) => `${(index / Math.max(1, points.length - 1)) * 100},${100 - point.value}`).join(' ')
  return <><div className="chart-legend"><span><i className="legend-line" /> Report score</span><span>0–100 scale</span></div><div aria-label="Evaluation score trend" className="score-chart" role="img"><div className="chart-y-labels"><span>100</span><span>75</span><span>50</span><span>25</span><span>0</span></div><svg preserveAspectRatio="none" viewBox="0 0 100 100"><line x1="0" x2="100" y1="0" y2="0" /><line x1="0" x2="100" y1="25" y2="25" /><line x1="0" x2="100" y1="50" y2="50" /><line x1="0" x2="100" y1="75" y2="75" /><line x1="0" x2="100" y1="100" y2="100" /><polyline points={coordinates} /></svg></div><div className="chart-x-labels">{points.map((point) => <span key={point.label}>{point.label}</span>)}</div></>
}

function AgentComparison({ apiData, runs }: { apiData: boolean; runs: ApiRun[] }) {
  const sourceRuns = apiData ? runs.map(apiRunToView) : demoRuns
  const models = Array.from(new Set(sourceRuns.map((run) => run.model))).map((name) => {
    const modelRuns = sourceRuns.filter((run) => run.model === name)
    const scores = modelRuns.map((run) => run.score).filter((score): score is number => score !== null)
    return { name, score: scores.length ? Math.round(scores.reduce((total, score) => total + score, 0) / scores.length) : null, count: modelRuns.length, color: name.includes('defective') ? 'amber' : 'accent' }
  })
  return <>
    <section className="panel comparison-panel"><div className="panel-heading"><div><span className="section-kicker">Agent comparison</span><h2>{apiData ? 'By persisted report' : 'By fixture run'}</h2></div><span className="muted-label">Average score</span></div><div className="comparison-list">{models.length ? models.map((model) => <div className="comparison-row" key={model.name}><span className={`model-bullet bullet-${model.color}`} /><span className="model-name"><strong>{model.name}</strong><small>{model.count} {model.count === 1 ? 'run' : 'runs'}</small></span><span className="model-score"><strong>{formatScore(model.score)}</strong><span className="mini-track"><span className={`mini-fill fill-${model.color}`} style={{ width: `${model.score ?? 0}%` }} /></span></span></div>) : <EmptyPanel description="No persisted reports to compare." />}</div><p className="panel-footnote">{apiData ? 'Averages are calculated from report evaluation invariants.' : 'Fixture comparison is read-only and not a backend claim.'}</p></section>
    <RunComparison apiData={apiData} runs={sourceRuns} />
  </>
}

function RunComparison({ apiData, runs }: { apiData: boolean; runs: Run[] }) {
  const [leftId, setLeftId] = useState(runs[0]?.id ?? '')
  const [rightId, setRightId] = useState(runs[1]?.id ?? runs[0]?.id ?? '')
  const left = runs.find((run) => run.id === leftId) ?? null
  const right = runs.find((run) => run.id === rightId) ?? null

  useEffect(() => {
    if (!runs.some((run) => run.id === leftId)) setLeftId(runs[0]?.id ?? '')
    if (!runs.some((run) => run.id === rightId)) setRightId(runs[1]?.id ?? runs[0]?.id ?? '')
  }, [leftId, rightId, runs])

  return <section className="panel run-comparison-panel"><div className="panel-heading"><div><span className="section-kicker">Compare loaded runs</span><h2>Side-by-side signal</h2></div><span className="muted-label">{apiData ? 'Selected project data' : 'Fixture data'}</span></div><p className="comparison-help">Choose two runs already loaded in this workspace. Scores and timing stay blank when the source did not provide them.</p><div className="comparison-selectors"><label>Run A<select onChange={(event) => setLeftId(event.target.value)} value={leftId}><option value="">Select a run</option>{runs.map((run) => <option key={run.id} value={run.id}>{run.name} · {run.id}</option>)}</select></label><span className="comparison-vs">vs</span><label>Run B<select onChange={(event) => setRightId(event.target.value)} value={rightId}><option value="">Select a run</option>{runs.map((run) => <option key={run.id} value={run.id}>{run.name} · {run.id}</option>)}</select></label></div>{left && right ? <div className="comparison-facts"><ComparisonFact label="Status" left={humanizeState(left.status)} right={humanizeState(right.status)} /><ComparisonFact label="Score" left={formatScore(left.score)} right={formatScore(right.score)} /><ComparisonFact label="Timing" left={left.duration} right={right.duration} /><ComparisonFact label="Evidence" left={`${left.passedCases}/${left.cases} ${left.caseLabel ?? 'cases'}`} right={`${right.passedCases}/${right.cases} ${right.caseLabel ?? 'cases'}`} /></div> : <EmptyPanel description="Select two runs to compare their observed results." />}</section>
}

function ComparisonFact({ label, left, right }: { label: string; left: string; right: string }) {
  return <div className="comparison-fact"><span>{label}</span><strong>{left}</strong><strong>{right}</strong></div>
}

function RunDetail({ api, apiRun, loading, onBack, onRunUpdated, run, token }: { api: ApiClient; apiRun: ApiRun | null; loading: boolean; onBack: () => void; onRunUpdated: (run: ApiRun) => void; run: Run | null; token: string | null }) {
  if (apiRun && token) return <RunExecutionView api={api} initialRun={apiRun} onBack={onBack} onRunUpdated={onRunUpdated} token={token} />
  if (loading) return <><BackButton onBack={onBack} /><div className="detail-loading">Loading persisted report…</div></>
  if (!run) return <><BackButton onBack={onBack} /><EmptyState title="Run not found" description="This run is not available in the selected project." actionLabel="Back to runs" onAction={onBack} /></>
  return <DemoRunDetail onBack={onBack} run={run} />
}

function BackButton({ onBack }: { onBack: () => void }) {
  return <button className="back-button" onClick={onBack} type="button"><Icon name="arrow-left" size={16} /> Back to runs</button>
}

function DemoRunDetail({ onBack, run }: { onBack: () => void; run: Run }) {
  const score = run.score ?? 0
  return <><BackButton onBack={onBack} /><RunHeader run={run} /><div className="run-summary-grid"><div className={`run-score-card ${run.status === 'needs-review' ? 'run-score-card-failed' : ''}`}><span className="section-kicker">Fixture score</span><strong>{score}<small>%</small></strong><span className={run.status === 'needs-review' ? 'negative' : 'positive'}><Icon name={run.status === 'needs-review' ? 'warning' : 'check'} size={14} /> Repository-owned fixture</span></div><SummaryCard icon="check" tone="green" label="Passed cases" value={`${run.passedCases} / ${run.cases}`} detail={`${Math.round((run.passedCases / run.cases) * 100)}% fixture pass rate`} /><SummaryCard icon="activity" tone="violet" label="Trace events" value={run.duration.replace(' events', '')} detail="Local deterministic fixture" /></div><div className="run-detail-grid"><section className="panel evaluators-panel"><PanelTitle eyebrow="Independent checks" title="Evaluator breakdown" meta={`${demoEvaluators.length} fixture checks`} /><div className="evaluator-list">{demoEvaluators.map((evaluator) => <EvaluatorRow evaluator={evaluator} key={evaluator.name} />)}</div></section><section className="panel config-panel"><PanelTitle eyebrow="Execution context" title="Fixture configuration" /><div className="config-list"><ConfigRow label="Agent" value={run.model} /><ConfigRow label="Dataset" value={run.dataset} /><ConfigRow label="Run id" value={run.id} /><ConfigRow label="Persistence" value="Local fixture only" /></div></section></div><section className="panel fixture-evidence"><PanelTitle eyebrow="Evidence boundary" title="Why this detail is local" /><p>This detail is rendered from the repository-owned fixture set because no authenticated project is selected. It cannot be exported as an API report or written back to the server.</p><button className="text-button" onClick={() => onBack()} type="button">Return to run history <Icon name="arrow-right" size={15} /></button></section></>
}

function ApiRunDetail({ apiRun, onBack }: { apiRun: ApiRun; onBack: () => void }) {
  const report = apiRun.report
  if (!report) return <><BackButton onBack={onBack} /><div className="inline-error" role="alert">This persisted run has no report. {apiRun.error_message ?? 'The API did not return an execution report.'}</div></>
  const score = runScore(report)
  const evaluation = report.evaluation
  return <><BackButton onBack={onBack} /><div className="run-detail-header"><div><div className="run-id-line"><span className="run-id-badge">{apiRun.id}</span><StatusBadge status={apiRun.state === 'passed' ? 'completed' : apiRun.state === 'failed' ? 'needs-review' : 'running'} /></div><h1>{report.agent_name}</h1><p>{formatScenario(apiRun.scenario)} <span>·</span> {formatDate(apiRun.completed_at ?? apiRun.created_at)} <span>·</span> persisted API report</p></div><div className="run-detail-actions"><button className="button button-quiet" onClick={() => downloadReport(apiRun)} type="button"><Icon name="download" size={15} /> Export JSON</button></div></div><div className="run-summary-grid"><div className={`run-score-card ${evaluation.passed ? '' : 'run-score-card-failed'}`}><span className="section-kicker">Report evaluation</span><strong>{score === null ? '—' : score}<small>{score === null ? '' : '%'}</small></strong><span className={evaluation.passed ? 'positive' : 'negative'}><Icon name={evaluation.passed ? 'check' : 'warning'} size={14} /> {evaluation.passed ? 'All invariants passed' : `${evaluation.findings.length} finding${evaluation.findings.length === 1 ? '' : 's'} recorded`}</span></div><SummaryCard icon="activity" tone="violet" label="Trace events" value={formatNumber(report.trace.length)} detail="From persisted report.trace" /><SummaryCard icon="database" tone="green" label="Ledger entries" value={formatNumber(report.ledger.entries.length)} detail={`${report.order.status} final order state`} /></div><div className="metric-grid report-metrics"><MetricCard label="Payment attempts" value={formatNumber(report.metrics.payment_attempts)} detail="report.metrics" icon="activity" tone="accent" /><MetricCard label="Retries" value={formatNumber(report.metrics.retries)} detail="report.metrics" icon="refresh" tone="violet" /><MetricCard label="Reconciliations" value={formatNumber(report.metrics.reconciliations)} detail="report.metrics" icon="shield" tone="green" /><MetricCard label="Duplicate charges" value={formatNumber(report.metrics.duplicate_charges)} detail="report.metrics" icon="warning" tone="amber" /></div><section className="panel evaluators-panel report-evaluators"><PanelTitle eyebrow="Independent checks" title="Evaluator breakdown" meta={`${evaluation.invariants.length} invariants`} /><div className="evaluator-list">{evaluation.invariants.map((invariant) => <ApiInvariantRow invariant={invariant} key={invariant.name} />)}</div></section><ApiEvidence report={report} /><FindingsPanel findings={evaluation.findings} /></>
}

function RunHeader({ run }: { run: Run }) {
  return <div className="run-detail-header"><div><div className="run-id-line"><span className="run-id-badge">{run.id}</span><StatusBadge status={run.status} /></div><h1>{run.name}</h1><p>{run.model} <span>·</span> {run.dataset} <span>·</span> {run.completedAt}</p></div><span className="local-label"><Icon name="layers" size={14} /> fixture detail</span></div>
}

function SummaryCard({ detail, icon, label, tone, value }: { detail: string; icon: IconName; label: string; tone: string; value: string }) {
  return <div className="run-summary-card"><span className={`summary-card-icon icon-${tone}`}><Icon name={icon} size={16} /></span><span className="section-kicker">{label}</span><strong>{value}</strong><span>{detail}</span></div>
}

function PanelTitle({ eyebrow, meta, title }: { eyebrow: string; meta?: string; title: string }) {
  return <div className="panel-heading"><div><span className="section-kicker">{eyebrow}</span><h2>{title}</h2></div>{meta && <span className="muted-label">{meta}</span>}</div>
}

function EvaluatorRow({ evaluator }: { evaluator: EvaluatorResult }) {
  const passed = evaluator.status === 'passed'
  return <div className="evaluator-row"><span className={`evaluator-icon ${passed ? 'evaluator-pass' : 'evaluator-attention'}`}><Icon name={passed ? 'check' : 'warning'} size={15} /></span><span className="evaluator-copy"><strong>{evaluator.name}</strong><span>{evaluator.description}</span></span><span className={`evaluator-score ${passed ? '' : 'negative'}`}><strong>{evaluator.score}%</strong><small>{evaluator.passed}/{evaluator.total}</small></span></div>
}

function ApiInvariantRow({ invariant }: { invariant: ApiEvaluation['invariants'][number] }) {
  return <div className="evaluator-row"><span className={`evaluator-icon ${invariant.passed ? 'evaluator-pass' : 'evaluator-attention'}`}><Icon name={invariant.passed ? 'check' : 'warning'} size={15} /></span><span className="evaluator-copy"><strong>{invariant.name}</strong><span>{invariant.evidence.length ? invariant.evidence.join(' · ') : 'No evidence recorded.'}</span></span><span className={`evaluator-score ${invariant.passed ? '' : 'negative'}`}><strong>{invariant.passed ? 'PASS' : 'FAIL'}</strong><small>{invariant.evidence.length} evidence</small></span></div>
}

function ApiEvidence({ report }: { report: ApiReport }) {
  return <section className="panel api-evidence-panel"><PanelTitle eyebrow="Persisted evidence" title="Ledger and trace" meta="report JSON" /><div className="evidence-columns"><div><h3>Ledger entries</h3>{report.ledger.entries.length ? <div className="ledger-list">{report.ledger.entries.map((entry) => <div className="ledger-entry" key={entry.entry_id}><span className="ledger-entry-icon"><Icon name={entry.entry_type === 'charge' ? 'database' : 'arrow-right'} size={14} /></span><span><strong>{entry.entry_id}</strong><small>{entry.entry_type} · {entry.payment_id} · key {entry.idempotency_key}</small></span><b>{entry.amount} {entry.currency}</b></div>)}</div> : <EmptyPanel description="No ledger entries recorded." />}</div><div><h3>Trace events</h3>{report.trace.length ? <div className="trace-list">{report.trace.map((event) => <div className="trace-entry" key={`${event.index}-${event.event_type}`}><span className="trace-index">{String(event.index).padStart(2, '0')}</span><span><strong>{event.event_type}</strong><small>{formatAttributes(event.attributes)}</small></span></div>)}</div> : <EmptyPanel description="No trace events recorded." />}</div></div></section>
}

function FindingsPanel({ findings }: { findings: ApiEvaluation['findings'] }) {
  return <section className="panel findings-panel"><PanelTitle eyebrow="Evaluation findings" title="What needs attention" meta={`${findings.length} findings`} />{findings.length ? <div className="finding-list">{findings.map((finding) => <article className={`finding-card ${finding.severity.toLowerCase() === 'error' ? 'finding-error' : ''}`} key={finding.code}><div className="finding-heading"><Icon name={finding.severity.toLowerCase() === 'error' ? 'warning' : 'activity'} size={15} /><strong>{finding.title}</strong><span className="finding-code">{finding.code} · {finding.severity}</span></div><p>{finding.recommendation}</p>{finding.evidence.length > 0 && <small>{finding.evidence.join(' · ')}</small>}</article>)}</div> : <div className="success-empty"><Icon name="check" size={17} /><span>No findings recorded for this report.</span></div>}</section>
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return <div className="config-row"><span>{label}</span><strong>{value}</strong></div>
}

function formatAttributes(attributes: Record<string, string | number | boolean | null>) {
  const entries = Object.entries(attributes).filter(([, value]) => value !== null)
  return entries.length ? entries.map(([key, value]) => `${key}=${String(value)}`).join(' · ') : 'no attributes'
}

function downloadReport(run: ApiRun) {
  if (!run.report) return
  const blob = new Blob([JSON.stringify(run.report, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = `${run.id}-report.json`; anchor.click(); URL.revokeObjectURL(url)
}

function DatasetsPage({ datasets, onAdd }: { datasets: LocalDataset[]; onAdd: (dataset: LocalDataset) => void; onSelect: (view: View) => void }) {
  const [formOpen, setFormOpen] = useState(false)
  const [selectedId, setSelectedId] = useState(datasets[0]?.id ?? '')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const selected = datasets.find((dataset) => dataset.id === selectedId)
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const dataset: LocalDataset = { id: `local-${Date.now()}`, name, description, cases: 0, kind: 'local', updated: 'Created locally' }
    onAdd(dataset); setSelectedId(dataset.id); setName(''); setDescription(''); setFormOpen(false)
  }
  return <><PageIntro eyebrow="Local configuration" title="Datasets" description="Keep scenario context close to the work. This catalog is stored in your browser and does not create API resources." action={<button className="button button-secondary" onClick={() => setFormOpen((current) => !current)} type="button"><Icon name="file-plus" size={14} /> {formOpen ? 'Close form' : 'Add local dataset'}</button>} /><div className="local-state-banner"><Icon name="layers" size={16} /><span><strong>Frontend-local only.</strong> Repository fixtures remain read-only. New entries are saved to localStorage and are not sent with persisted API runs.</span></div>{formOpen && <form className="panel local-form" onSubmit={submit}><div><span className="section-kicker">New local entry</span><h2>Describe a dataset for your workspace</h2></div><label>Name<input onChange={(event) => setName(event.target.value)} placeholder="e.g. Checkout regressions" required value={name} /></label><label>Description<textarea onChange={(event) => setDescription(event.target.value)} placeholder="What does this set cover?" required rows={3} value={description} /></label><div className="form-actions"><button className="button button-primary" type="submit">Save locally</button><button className="button button-quiet" onClick={() => setFormOpen(false)} type="button">Cancel</button></div></form>}<div className="dataset-layout"><section className="panel dataset-list-panel"><PanelTitle eyebrow="Available context" title="Dataset catalog" meta={`${datasets.length} entries`} /><div className="dataset-list">{datasets.map((dataset) => <button className={`dataset-row ${selectedId === dataset.id ? 'dataset-row-active' : ''}`} key={dataset.id} onClick={() => setSelectedId(dataset.id)} type="button"><span className="dataset-icon"><Icon name={dataset.kind === 'fixture' ? 'database' : 'file-plus'} size={16} /></span><span><strong>{dataset.name}</strong><small>{dataset.cases ? `${dataset.cases} cases` : 'No cases defined'} · {dataset.kind === 'fixture' ? 'fixture' : 'local config'}</small></span><Icon name="chevron-right" size={15} /></button>)}</div></section><section className="panel dataset-detail"><PanelTitle eyebrow={selected?.kind === 'fixture' ? 'Repository fixture' : 'Local config'} title={selected?.name ?? 'Select a dataset'} />{selected ? <><p className="detail-copy">{selected.description}</p><div className="detail-facts"><ConfigRow label="Cases" value={selected.cases ? String(selected.cases) : 'Not defined'} /><ConfigRow label="Source" value={selected.kind === 'fixture' ? 'Repository-owned' : 'Browser localStorage'} /><ConfigRow label="Updated" value={selected.updated} /></div><div className="detail-callout"><Icon name="shield" size={15} /><span>{selected.kind === 'fixture' ? 'This fixture is available to inspect offline.' : 'This entry is a planning aid; connecting it to the API is not implemented.'}</span></div></> : <EmptyPanel description="Choose a dataset to inspect its local metadata." />}</section></div></>
}

function EvaluatorsPage({ enabled, onToggle }: { enabled: string[]; onToggle: (id: string) => void }) {
  return <><PageIntro eyebrow="Local configuration" title="Evaluators" description="Understand the checks behind a report and choose which checks you want to keep visible in this browser." /><div className="local-state-banner"><Icon name="sliders" size={16} /><span><strong>Configuration-only state.</strong> These toggles are stored locally for workspace organization. Persisted API evaluation results still come from <code>report.evaluation</code>.</span></div><div className="evaluator-config-grid">{evaluatorDefinitions.map((evaluator) => { const isEnabled = enabled.includes(evaluator.id); return <article className={`panel evaluator-config-card ${isEnabled ? '' : 'is-disabled'}`} key={evaluator.id}><div className="evaluator-config-top"><span className="evaluator-icon evaluator-pass"><Icon name="check" size={15} /></span><span className="local-pill">{evaluator.owner}</span></div><h2>{evaluator.name}</h2><p>{evaluator.description}</p><div className="toggle-row"><span>{isEnabled ? 'Visible in local workspace' : 'Hidden locally'}</span><button aria-pressed={isEnabled} className={`switch ${isEnabled ? 'switch-on' : ''}`} onClick={() => onToggle(evaluator.id)} type="button"><span /></button></div></article> })}</div><section className="panel evaluator-note"><Icon name="shield" size={17} /><div><strong>How report evaluation works</strong><p>When a persisted run is created, the API executes the sample agent and returns its own invariant and finding results. This page does not replace or edit those server-backed results.</p></div></section></>
}

function SettingsPage({ apiStatus, enabledEvaluators, localSettings, onCheck, onReset, onSettingsChange, onThemeChange, session, theme }: { apiStatus: ApiStatus; enabledEvaluators: number; localSettings: LocalSettings; onCheck: () => void; onReset: () => void; onSettingsChange: (next: Partial<LocalSettings>) => void; onThemeChange: (theme: Theme) => void; session: Session | null; theme: Theme }) {
  return <><PageIntro eyebrow="Workspace preferences" title="Settings" description="Tune the local shell and inspect the current API connection without implying server-side configuration." /><div className="settings-grid"><section className="panel settings-section"><PanelTitle eyebrow="Appearance" title="Theme" meta="Saved locally" /><p className="settings-description">Choose a durable light or dark presentation for this browser.</p><div className="theme-options"><button className={`theme-option ${theme === 'light' ? 'theme-option-active' : ''}`} onClick={() => onThemeChange('light')} type="button"><Icon name="sun" size={18} /><span><strong>Light</strong><small>Bright workspace</small></span></button><button className={`theme-option ${theme === 'dark' ? 'theme-option-active' : ''}`} onClick={() => onThemeChange('dark')} type="button"><Icon name="moon" size={18} /><span><strong>Dark</strong><small>Low-glare workspace</small></span></button></div></section><section className="panel settings-section"><PanelTitle eyebrow="API connection" title="Service status" meta="Read-only check" /><div className="connection-row"><span className={`connection-indicator connection-${apiStatus}`} /><span><strong>{apiStatus === 'online' ? 'API reachable' : apiStatus === 'offline' ? 'API unavailable' : 'Checking API'}</strong><small>{import.meta.env.VITE_API_URL ?? 'http://localhost:8000'}</small></span><button className="button button-quiet" onClick={onCheck} type="button"><Icon name="refresh" size={14} /> Check</button></div><p className="settings-description">The endpoint is read from <code>VITE_API_URL</code> or the client default. There is no editable remote configuration in this page.</p></section><section className="panel settings-section"><PanelTitle eyebrow="Local behavior" title="Workspace hints" meta={`${enabledEvaluators} evaluators visible`} /><label className="check-row"><input checked={localSettings.showFixtureHints} onChange={(event) => onSettingsChange({ showFixtureHints: event.target.checked })} type="checkbox" /><span><strong>Show data source notices</strong><small>Keep fixture and persisted-data boundaries visible.</small></span></label><label className="check-row"><input checked={localSettings.compactRows} onChange={(event) => onSettingsChange({ compactRows: event.target.checked })} type="checkbox" /><span><strong>Use compact run rows</strong><small>Reduce table row height in Agent runs.</small></span></label></section><section className="panel settings-section danger-section"><PanelTitle eyebrow="Local data" title="Reset browser configuration" /><p className="settings-description">Restore locally created dataset entries, evaluator visibility, and display preferences. This does not delete API projects, runs, or reports.</p><button className="button button-quiet" onClick={onReset} type="button">Reset local configuration</button></section></div><section className="panel account-section"><PanelTitle eyebrow="Authentication" title="Current session" />{session ? <div className="account-row"><span className="user-avatar">{session.user.email.slice(0, 2).toUpperCase()}</span><span><strong>{session.user.email}</strong><small>Authenticated API session</small></span></div> : <div className="account-row"><span className="user-avatar">DE</span><span><strong>No authenticated session</strong><small>Local fixtures remain available offline.</small></span></div>}</section></>
}

function LegacyCliGuide() {
  const [language, setLanguage] = useState<'curl' | 'node'>('curl')
  const installCli = `git clone https://github.com/Aryan107rn/VerityBench.git
cd VerityBench
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.lock
python -m pip install .
veritybench --version`
  const localSetup = `mkdir private-agent-check
cd private-agent-check
veritybench init
veritybench agent init ./my-agent.py
veritybench validate`
  const localRun = `veritybench test \\
  --agent-path ./my-agent.py \\
  --scenario timeout_after_success \\
  --output runs/my-agent-timeout.json
veritybench report runs/my-agent-timeout.json`
  const localSmoke = `veritybench test \\
  --agent safe \\
  --scenario all \\
  --json \\
  --output runs/safe-suite.json`
  const ciRun = `veritybench test \\
  --agent-path ./my-agent.py \\
  --scenario all \\
  --json \\
  --output runs/ci-report.json`
  const curlAuth = `curl -s -X POST http://localhost:8000/api/v1/auth/login -H 'Content-Type: application/json' -d '{"email":"you@example.com","password":"your-password"}'`
  const nodeAuth = [
    "const response = await fetch(`${API_URL}/api/v1/auth/login`, {",
    "  method: 'POST',",
    "  headers: { 'Content-Type': 'application/json' },",
    "  body: JSON.stringify({ email, password }),",
    '})',
    'const { access_token } = await response.json()',
  ].join('\n')
  const createRun = `curl -s -X POST http://localhost:8000/api/v1/projects/PROJECT_ID/runs -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"agent":"safe","scenario":"timeout_after_success"}'`
  const fetchReport = 'curl -s http://localhost:8000/api/v1/runs/RUN_ID -H "Authorization: Bearer $TOKEN"'
  return <><PageIntro eyebrow="Developer workflow" title="CLI guide" description="Install the real VerityBench command, test an agent locally, and keep source code private. HTTP examples remain available as advanced usage." action={<span className="local-pill"><Icon name="terminal" size={13} /> Local-first</span>} /><div className="local-state-banner cli-privacy-banner"><Icon name="shield" size={16} /><span><strong>Private local mode.</strong> <code>veritybench test</code> runs from your checkout, does not require login, and does not upload agent source. Use <code>sync</code> or the HTTP API only when you explicitly choose remote execution.</span></div><div className="cli-layout"><aside className="panel cli-nav"><span className="section-kicker">Contents</span><a href="#install-cli">01 · Install CLI</a><a href="#test-locally">02 · Test locally</a><a href="#privacy">03 · Privacy boundary</a><a href="#reports-ci">04 · Reports &amp; CI/CD</a><a href="#advanced-api">05 · HTTP API / Advanced</a></aside><div className="cli-content"><section className="cli-section" id="install-cli"><StepHeading number="01" title="Install the CLI" description="Install the packaged veritybench executable from a clean checkout. The command is registered by pyproject.toml." /><p className="cli-copy">Prerequisites: Python 3.12.8, pip, and Git. Docker is only needed when testing your own custom agent through <code>--agent-path</code>.</p><CommandBlock command={installCli} /></section><section className="cli-section" id="test-locally"><StepHeading number="02" title="Test locally" description="Initialize a private workspace, generate the supported agent starter, select a scenario, and save the evidence report." /><CommandBlock command={localSetup} /><div className="cli-substep"><span>Run your agent</span><CommandBlock command={localRun} /></div><div className="cli-substep"><span>Or smoke-test the local engine without Docker</span><CommandBlock command={localSmoke} /></div></section><section className="cli-section" id="privacy"><StepHeading number="03" title="Keep source private" description="Local mode is deliberately separate from API-backed runs." /><div className="cli-facts"><div><strong>Local</strong><span><code>veritybench test</code> reads the agent path from your checkout and writes reports locally.</span></div><div><strong>Sandbox</strong><span>Custom agents run in Docker with no network, read-only files, non-root execution, and bounded resources.</span></div><div><strong>Remote</strong><span><code>sync</code>, GitHub import, and API registration are opt-in workflows; do not use them for private source.</span></div></div></section><section className="cli-section" id="reports-ci"><StepHeading number="04" title="Reports and CI/CD" description="Use readable terminal output for humans and JSON plus exit codes for automation." /><CommandBlock command={ciRun} /><p className="cli-copy">Exit codes: <code>0</code> passed, <code>1</code> independent evaluation found a defect, <code>2</code> invalid input or worker refusal, and <code>124</code> bounded worker timeout. Add <code>NO_COLOR=1</code> for plain terminal output.</p><CommandBlock command="veritybench runs show runs/ci-report.json --json" /></section><section className="cli-section cli-section-advanced" id="advanced-api"><StepHeading number="05" title="HTTP API / Advanced Usage" description="These examples target a running backend and are not required for private local testing." /><div className="cli-advanced-label">Backend health</div><CommandBlock command="curl -s http://localhost:8000/health" /><div className="cli-advanced-label">Authenticate</div><div className="code-tabs"><button className={language === 'curl' ? 'code-tab-active' : ''} onClick={() => setLanguage('curl')} type="button">curl</button><button className={language === 'node' ? 'code-tab-active' : ''} onClick={() => setLanguage('node')} type="button">Node fetch</button></div><CommandBlock command={language === 'curl' ? curlAuth : nodeAuth} /><div className="cli-advanced-label">Create and fetch a persisted run</div><CommandBlock command={`${createRun}\n\n${fetchReport}`} /></section></div></div></>
}

function CliGuide() {
  const [language, setLanguage] = useState<'curl' | 'node'>('curl')
  const installCli = `git clone https://github.com/Aryan107rn/VerityBench.git
cd VerityBench
python -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.lock
python -m pip install .
veritybench --version`
  const archSetup = `sudo pacman -Syu
sudo pacman -S --needed git python python-pip docker docker-compose
sudo systemctl enable --now docker.service
sudo usermod -aG docker "$USER"
newgrp docker
docker info`
  const localSetup = `mkdir private-agent-check
cd private-agent-check
veritybench init
veritybench agent init ./my-agent.py
veritybench validate
veritybench scenarios list`
  const localRun = `veritybench test \\
  --agent-path ./my-agent.py \\
  --scenario timeout_after_success \\
  --output runs/my-agent-timeout.json
veritybench report runs/my-agent-timeout.json`
  const scenarioRun = `veritybench test \\
  --agent safe \\
  --scenario rate_limited \\
  --param failure_count=2 \\
  --seed 7`
  const dockerImage = `docker build --target api -t localhost:5000/veritybench-agent:local .
docker run -d --restart unless-stopped --name veritybench-registry \\
  -p 5000:5000 registry:2
 docker push localhost:5000/veritybench-agent:local
 export VERITYBENCH_AGENT_IMAGE="$(docker image inspect \\
  --format '{{index .RepoDigests 0}}' \\
   localhost:5000/veritybench-agent:local)"`
  const terminalReport = `veritybench test --agent safe --scenario timeout_after_success
veritybench report runs/latest.json
NO_COLOR=1 veritybench report runs/latest.json`
  const jsonReport = `veritybench test \\
  --agent-path ./my-agent.py \\
  --scenario all \\
  --json \\
  --output runs/ci-report.json
veritybench runs show runs/ci-report.json --json`
  const curlAuth = `curl -s -X POST http://localhost:8000/api/v1/auth/login -H 'Content-Type: application/json' -d '{"email":"you@example.com","password":"your-password"}'`
  const nodeAuth = [
    "const response = await fetch(`${API_URL}/api/v1/auth/login`, {",
    "  method: 'POST',",
    "  headers: { 'Content-Type': 'application/json' },",
    "  body: JSON.stringify({ email, password }),",
    '})',
    'const { access_token } = await response.json()',
  ].join('\n')
  const createRun = `curl -s -X POST http://localhost:8000/api/v1/projects/PROJECT_ID/runs -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"agent":"safe","scenario":"timeout_after_success"}'`
  const fetchReport = 'curl -s http://localhost:8000/api/v1/runs/RUN_ID -H "Authorization: Bearer $TOKEN"'

  return (
    <>
      <PageIntro
        eyebrow="Developer workflow"
        title="CLI guide"
        description="Install VerityBench, test a private agent locally, and inspect the branded evidence report. HTTP examples are clearly separated as advanced usage."
        action={<span className="local-pill"><Icon name="terminal" size={13} /> Local-first</span>}
      />
      <div className="local-state-banner cli-privacy-banner">
        <Icon name="shield" size={16} />
        <span><strong>Private local mode.</strong> <code>veritybench test</code> runs from your checkout, requires no login, and does not upload agent source. Use <code>sync</code> or the HTTP API only when you explicitly choose remote execution.</span>
      </div>
      <div className="cli-layout">
        <aside className="panel cli-nav">
          <span className="section-kicker">Contents</span>
          <a href="#install-cli">01 · Install CLI</a>
          <a href="#arch-setup">02 · Arch / Omarchy</a>
          <a href="#test-locally">03 · Test locally</a>
          <a href="#docker-agent">04 · Private Docker agent</a>
          <a href="#terminal-reports">05 · Branded reports</a>
          <a href="#reports-ci">06 · Reports &amp; CI/CD</a>
          <a href="#advanced-api">07 · HTTP API / Advanced</a>
        </aside>
        <div className="cli-content">
          <section className="cli-section" id="install-cli">
            <StepHeading number="01" title="Install the CLI" description="Install the packaged veritybench executable from a clean checkout. The command is registered by pyproject.toml." />
            <p className="cli-copy">Prerequisites: Python 3.12–3.14, pip, and Git. Docker is only needed when testing your own custom agent through <code>--agent-path</code>.</p>
            <CommandBlock command={installCli} />
          </section>
          <section className="cli-section" id="arch-setup">
            <StepHeading number="02" title="Arch Linux / Omarchy setup" description="Use this once on an Arch-based machine when you want to run a private custom agent inside Docker." />
            <CommandBlock command={archSetup} />
            <p className="cli-copy">If you only run the repository-owned sample agents, Docker is not required. If Docker group permissions do not apply immediately, log out and back in, then run <code>docker info</code> again.</p>
          </section>
          <section className="cli-section" id="test-locally">
            <StepHeading number="03" title="Test locally" description="Initialize a private workspace, create the supported agent starter, select scenarios, and save evidence locally." />
            <CommandBlock command={localSetup} />
            <div className="cli-substep"><span>Run your private agent</span><CommandBlock command={localRun} /></div>
            <div className="cli-substep"><span>Configure a deterministic scenario</span><CommandBlock command={scenarioRun} /></div>
          </section>
          <section className="cli-section" id="docker-agent">
            <StepHeading number="04" title="Run a private agent in Docker" description="Build a compatible local image, pin it by digest, and then execute the agent without sending source to VerityBench." />
            <CommandBlock command={dockerImage} />
            <div className="cli-substep"><span>Execute the pinned image</span><CommandBlock command={`veritybench test \\
  --agent-path ./my-agent.py \\
  --scenario timeout_after_success \\
  --timeout 20 \\
  --output runs/docker-timeout.json`} /></div>
            <p className="cli-copy">The sandbox uses no network, a read-only filesystem, non-root execution, dropped capabilities, and bounded CPU, memory, process count, and output. The API is not involved.</p>
          </section>
          <section className="cli-section" id="terminal-reports">
            <StepHeading number="05" title="See the branded terminal report" description="Human output uses the VerityBench logo, verdict, metrics, independent checks, evidence, findings, and recommendations." />
            <CommandBlock command={terminalReport} />
            <p className="cli-copy">The logo and styled report are the default terminal experience. Use <code>NO_COLOR=1</code> for plain text while keeping the report content. Use <code>--json</code> only for automation; JSON intentionally contains no terminal branding.</p>
          </section>
          <section className="cli-section" id="reports-ci">
            <StepHeading number="06" title="Reports and CI/CD" description="Use readable output for humans and JSON plus exit codes for automation." />
            <CommandBlock command={jsonReport} />
            <div className="cli-facts">
              <div><strong>0</strong><span>Evaluation passed.</span></div>
              <div><strong>1</strong><span>Independent evaluation found a defect.</span></div>
              <div><strong>2</strong><span>Invalid input, contract failure, or worker refusal.</span></div>
              <div><strong>124</strong><span>Bounded custom-agent execution timed out.</span></div>
            </div>
          </section>
          <section className="cli-section cli-section-advanced" id="advanced-api">
            <StepHeading number="07" title="HTTP API / Advanced Usage" description="These examples target a running backend and are not required for private local testing." />
            <div className="cli-advanced-label">Backend health</div>
            <CommandBlock command="curl -s http://localhost:8000/health" />
            <div className="cli-advanced-label">Authenticate</div>
            <div className="code-tabs"><button className={language === 'curl' ? 'code-tab-active' : ''} onClick={() => setLanguage('curl')} type="button">curl</button><button className={language === 'node' ? 'code-tab-active' : ''} onClick={() => setLanguage('node')} type="button">Node fetch</button></div>
            <CommandBlock command={language === 'curl' ? curlAuth : nodeAuth} />
            <div className="cli-advanced-label">Create and fetch a persisted run</div>
            <CommandBlock command={`${createRun}\n\n${fetchReport}`} />
          </section>
        </div>
      </div>
    </>
  )
}

function StepHeading({ description, number, title }: { description: string; number: string; title: string }) {
  return <div className="step-heading"><span>{number}</span><div><h2>{title}</h2><p>{description}</p></div></div>
}

function CommandBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(command); setCopied(true); window.setTimeout(() => setCopied(false), 1600) } catch { setCopied(false) }
  }
  return <div className="command-block"><pre><code>{command}</code></pre><button aria-label="Copy command" className="copy-button" onClick={() => void copy()} type="button"><Icon name={copied ? 'check' : 'copy'} size={15} />{copied ? 'Copied' : 'Copy'}</button></div>
}

function EmptyPanel({ description }: { description: string }) {
  return <div className="empty-panel"><Icon name="layers" size={18} /><span>{description}</span></div>
}

function EmptyState({ actionLabel, description, onAction, title }: { actionLabel: string; description: string; onAction: () => void; title: string }) {
  return <section className="empty-state"><span className="empty-state-icon"><Icon name="layers" size={21} /></span><h2>{title}</h2><p>{description}</p><button className="button button-secondary" onClick={onAction} type="button">{actionLabel} <Icon name="arrow-right" size={14} /></button></section>
}

function App() {
  return <BrowserRouter><Workspace /></BrowserRouter>
}

export default App
