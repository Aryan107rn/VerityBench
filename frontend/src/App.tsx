import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { BrowserRouter, useLocation, useNavigate } from 'react-router-dom'
import { Icon, type IconName } from './components/Icon'
import { demoCoverage, demoEvaluators, demoRuns, demoTrend } from './data/demo'
import {
  createApiClient,
  type ApiClient,
  type ApiEvaluation,
  type ApiProject,
  type ApiReport,
  type ApiRun,
  type ApiUser,
  type SupportedAgent,
  type SupportedScenario,
} from './lib/api'
import type { CoverageItem, EvaluatorResult, Run, TrendPoint, View } from './types'

const navItems: Array<{ id: View; label: string; icon: IconName }> = [
  { id: 'overview', label: 'Overview', icon: 'layers' },
  { id: 'dashboard', label: 'Agent runs', icon: 'activity' },
]

const viewLabels: Record<View, string> = {
  overview: 'Overview',
  dashboard: 'Agent runs',
  run: 'Run detail',
}

const scenarios: Array<{ value: SupportedScenario; label: string; description: string }> = [
  { value: 'normal', label: 'Normal payment', description: 'Provider returns a successful payment response.' },
  { value: 'timeout_after_success', label: 'Timeout after success', description: 'A charge succeeds but its response is lost.' },
  { value: 'malformed_response', label: 'Malformed response', description: 'The provider returns an unreadable response.' },
  { value: 'temporary_failure', label: 'Temporary failure', description: 'The first payment attempt fails temporarily.' },
  { value: 'unrecoverable_failure', label: 'Unrecoverable failure', description: 'Every payment attempt remains unsuccessful.' },
]

const scenarioLabels: Record<SupportedScenario, string> = Object.fromEntries(
  scenarios.map((scenario) => [scenario.value, scenario.label]),
) as Record<SupportedScenario, string>

type Session = { token: string; user: ApiUser }

type DashboardStats = {
  passRate: string
  passCount: string
  traceCount: string
  duplicateCharges: string
  safeRetests: string
}

const sessionStorageKey = 'veritybench.session'
const projectStorageKey = 'veritybench.project'

function readStoredSession(): Session | null {
  try {
    const value = window.localStorage.getItem(sessionStorageKey)
    if (!value) return null
    const session = JSON.parse(value) as Session
    return session.token && session.user?.email ? session : null
  } catch {
    return null
  }
}

function readStoredProject(): string | null {
  try {
    return window.localStorage.getItem(projectStorageKey)
  } catch {
    return null
  }
}

function saveStoredProject(projectId: string | null) {
  try {
    if (projectId) window.localStorage.setItem(projectStorageKey, projectId)
    else window.localStorage.removeItem(projectStorageKey)
  } catch {
    // A restricted browser storage implementation should not block the UI.
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
    modelVersion: report ? 'persisted report' : 'report unavailable',
    dataset: formatScenario(run.scenario),
    status: run.state === 'passed' ? 'completed' : run.state === 'failed' ? 'needs-review' : 'running',
    score: runScore(report),
    scoreDelta: null,
    completedAt: formatDate(run.completed_at ?? run.created_at),
    duration: report ? `${report.trace.length} trace events` : 'Report unavailable',
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
    passCount: reports.length ? `${passed} / ${reports.length}` : '—',
    traceCount: reports.length ? formatNumber(totalTraces) : '—',
    duplicateCharges: reports.length ? formatNumber(duplicateCharges) : '—',
    safeRetests: reports.length ? formatNumber(safeRetests) : '—',
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

function buildTrend(runs: ApiRun[]): TrendPoint[] {
  return runs
    .map(apiRunToView)
    .filter((run): run is Run & { score: number } => run.score !== null)
    .reverse()
    .map((run) => ({ label: run.id.slice(0, 8), value: run.score }))
}

function StatusBadge({ status }: { status: Run['status'] }) {
  const labels: Record<Run['status'], string> = {
    completed: 'Completed',
    running: 'Running',
    'needs-review': 'Needs review',
  }

  return (
    <span className={`status-badge status-${status}`}>
      <span className="status-dot" />
      {labels[status]}
    </span>
  )
}

function DemoPill({ apiStatus, apiMode }: { apiStatus: 'checking' | 'online' | 'offline'; apiMode: boolean }) {
  const label = apiMode ? 'Live API · persisted' : apiStatus === 'offline' ? 'Offline demo · fixtures' : apiStatus === 'checking' ? 'Checking API' : 'Demo fallback · fixtures'
  return (
    <span className={`demo-pill ${apiMode ? 'demo-pill-live' : ''}`}>
      <span className="demo-pulse" />
      {label}
    </span>
  )
}

function BrandMark() {
  return (
    <span aria-hidden="true" className="brand-mark">
      <span />
      <span />
      <span />
    </span>
  )
}

function Workspace() {
  const api = useMemo(() => createApiClient(), [])
  const location = useLocation()
  const navigate = useNavigate()
  const view: View = location.pathname === '/runs' ? 'dashboard' : location.pathname.startsWith('/runs/') ? 'run' : 'overview'
  const selectedRunId = location.pathname.startsWith('/runs/') ? decodeURIComponent(location.pathname.slice('/runs/'.length)) : null
  const [apiStatus, setApiStatus] = useState<'checking' | 'online' | 'offline'>('checking')
  const [authOpen, setAuthOpen] = useState(false)
  const [session, setSession] = useState<Session | null>(() => readStoredSession())
  const [projects, setProjects] = useState<ApiProject[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() => readStoredProject())
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [projectError, setProjectError] = useState('')
  const [apiRuns, setApiRuns] = useState<ApiRun[]>([])
  const [runsLoading, setRunsLoading] = useState(false)
  const [runError, setRunError] = useState('')
  const [runComposerOpen, setRunComposerOpen] = useState(false)
  const [runBusy, setRunBusy] = useState(false)
  const [runComposerError, setRunComposerError] = useState('')
  const [demoBannerVisible, setDemoBannerVisible] = useState(true)

  const token = session?.token ?? null
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null
  const apiMode = apiStatus === 'online' && Boolean(token && selectedProjectId)
  const displayRuns = apiMode ? apiRuns.map(apiRunToView) : demoRuns
  const selectedApiRun = apiRuns.find((run) => run.id === selectedRunId) ?? null
  const selectedRun = apiMode ? (selectedApiRun ? apiRunToView(selectedApiRun) : null) : demoRuns.find((run) => run.id === selectedRunId) ?? demoRuns[0]
  const apiStats = useMemo(() => buildApiStats(apiRuns), [apiRuns])
  const coverage = apiMode ? buildApiCoverage(apiRuns) : demoCoverage
  const trend = apiMode ? buildTrend(apiRuns) : demoTrend

  useEffect(() => {
    let active = true
    api.getHealth().then(() => active && setApiStatus('online')).catch(() => active && setApiStatus('offline'))
    return () => {
      active = false
    }
  }, [api])

  useEffect(() => {
    let active = true
    if (!token) {
      setProjects([])
      setSelectedProjectId(null)
      saveStoredProject(null)
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

    return () => {
      active = false
    }
  }, [api, token])

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

    return () => {
      active = false
    }
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
    return () => {
      active = false
    }
  }, [api, apiMode, selectedApiRun, selectedProjectId, selectedRunId, token, view])

  const setSignedIn = (nextSession: Session) => {
    try {
      window.localStorage.setItem(sessionStorageKey, JSON.stringify(nextSession))
    } catch {
      // The current session still works when persistent storage is unavailable.
    }
    setSession(nextSession)
    setAuthOpen(false)
  }

  const signOut = async () => {
    if (token) {
      try {
        await api.logout(token)
      } catch {
        // Clearing the local session is still the correct client-side logout.
      }
    }
    try {
      window.localStorage.removeItem(sessionStorageKey)
    } catch {
      // Ignore restricted storage.
    }
    setSession(null)
    setProjects([])
    setApiRuns([])
    navigate('/')
  }

  const selectProject = (projectId: string) => {
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
    if (!session) {
      setAuthOpen(true)
      return
    }
    if (!selectedProjectId) {
      setProjectError('Create or select a project before starting a persisted run.')
      return
    }
    setRunComposerError('')
    setRunComposerOpen(true)
    navigate('/runs')
  }

  const submitRun = async (agent: SupportedAgent, scenario: SupportedScenario) => {
    if (!token || !selectedProjectId) return
    setRunBusy(true)
    setRunComposerError('')
    try {
      const created = await api.createRun(token, selectedProjectId, agent, scenario)
      // Read it back through the protected detail endpoint so the detail page
      // always renders the persisted report, rather than a transient response.
      const persisted = await api.getApiRun(token, created.id)
      setApiRuns((current) => [persisted, ...current.filter((run) => run.id !== persisted.id)])
      setRunComposerOpen(false)
      navigate(`/runs/${encodeURIComponent(persisted.id)}`)
    } catch (error: unknown) {
      setRunComposerError(error instanceof Error ? error.message : 'The API could not persist this run.')
    } finally {
      setRunBusy(false)
    }
  }

  const setView = (nextView: View) => navigate(nextView === 'overview' ? '/' : '/runs')
  const openRun = (runId: string) => navigate(`/runs/${encodeURIComponent(runId)}`)

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="brand-lockup">
            <BrandMark />
            <span className="brand-name">verity<span>bench</span></span>
          </div>
          <button aria-label="Collapse navigation" className="icon-button sidebar-collapse" type="button">
            <Icon name="menu" size={19} />
          </button>
        </div>

        <div className="workspace-switcher">
          <span className="workspace-avatar">{selectedProject?.name.slice(0, 1).toUpperCase() ?? 'V'}</span>
          <span className="workspace-copy">
            <span className="workspace-label">Workspace</span>
            <strong>{selectedProject?.name ?? 'demo fallback workspace'}</strong>
          </span>
          <Icon name="chevron-down" size={15} />
        </div>

        <nav aria-label="Main navigation" className="main-nav">
          <span className="nav-section-label">Workspace</span>
          {navItems.map((item) => (
            <button
              aria-current={view === item.id || (view === 'run' && item.id === 'dashboard') ? 'page' : undefined}
              className={`nav-item ${view === item.id || (view === 'run' && item.id === 'dashboard') ? 'is-active' : ''}`}
              key={item.id}
              onClick={() => setView(item.id)}
              type="button"
            >
              <Icon name={item.icon} size={17} />
              <span className="nav-label">{item.label}</span>
              {item.id === 'dashboard' && <span className="nav-count">{String(displayRuns.length).padStart(2, '0')}</span>}
            </button>
          ))}

          <span className="nav-section-label nav-section-spaced">Manage</span>
          <button className="nav-item" type="button">
            <Icon name="database" size={17} />
            <span className="nav-label">Datasets</span>
            <span className="nav-soon">Soon</span>
          </button>
          <button className="nav-item" type="button">
            <Icon name="sliders" size={17} />
            <span className="nav-label">Evaluators</span>
            <span className="nav-soon">Soon</span>
          </button>
          <button className="nav-item" type="button">
            <Icon name="settings" size={17} />
            <span className="nav-label">Settings</span>
          </button>
        </nav>

        <div className="sidebar-bottom">
          <div className="usage-card">
            <div className="usage-heading">
              <span>{apiMode ? 'Project runs' : 'Local suite'}</span>
              <span className="usage-value">{apiMode ? displayRuns.length : '04'}</span>
            </div>
            <div aria-label={`${apiMode ? displayRuns.length : 4} available runs`} className="progress-track" role="progressbar">
              <span className="progress-fill usage-fill" style={{ width: `${apiMode ? Math.min(100, displayRuns.length * 10) : 32}%` }} />
            </div>
            <span className="usage-footnote">{apiMode ? 'persisted API runs' : 'read-only demo fixtures'}</span>
          </div>
          <div className="user-row">
            <span className="user-avatar">{session ? session.user.email.slice(0, 2).toUpperCase() : 'DE'}</span>
            <span className="user-copy">
              <strong>{session?.user.email ?? 'Demo explorer'}</strong>
              <span>{session ? 'Authenticated' : 'Offline mode'}</span>
            </span>
            {session ? <button aria-label="Sign out" className="icon-button subtle-icon" onClick={signOut} type="button"><Icon name="more" size={18} /></button> : <Icon name="more" size={18} />}
          </div>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="breadcrumbs" aria-label="Breadcrumb">
            <span>VerityBench</span>
            <span className="breadcrumb-separator">/</span>
            <strong>{viewLabels[view]}</strong>
          </div>
          <div className="topbar-actions">
            <DemoPill apiStatus={apiStatus} apiMode={apiMode} />
            <button aria-label="Search" className="search-button" type="button">
              <Icon name="search" size={16} />
              <span>Search</span>
              <kbd>⌘ K</kbd>
            </button>
            <button aria-label="Open notifications" className="icon-button notification-button" type="button">
              <Icon name="activity" size={18} />
              <span className="notification-dot" />
            </button>
            <button aria-label={session ? `Sign out ${session.user.email}` : 'Sign in'} className="topbar-avatar profile-button" onClick={session ? signOut : () => setAuthOpen(true)} type="button">
              {session ? session.user.email.slice(0, 2).toUpperCase() : 'SI'}
            </button>
          </div>
        </header>

        <main className="page-content">
          <ProjectBar
            apiStatus={apiStatus}
            error={projectError}
            loading={projectsLoading}
            onCreate={createProject}
            onOpenAuth={() => setAuthOpen(true)}
            onSelect={selectProject}
            projects={projects}
            selectedProjectId={selectedProjectId}
            session={session}
          />
          {demoBannerVisible && <div className={`demo-banner ${apiMode ? 'demo-banner-live' : ''}`}>
            <Icon name={apiMode ? 'shield' : 'sparkles'} size={16} />
            <span>
              <strong>{apiMode ? 'Live persisted API data' : apiStatus === 'offline' ? 'Offline demo fallback' : 'Demo fallback · local fixtures'}</strong>
              {' · '}
              {apiMode ? 'Runs, metrics, reports, and evidence are loaded from the selected project.' : apiStatus === 'offline' ? 'The API is unreachable; browse repository-owned reports without writing data.' : 'Sign in to run against the API; local fixtures are read-only and never persisted.'}
            </span>
            <button aria-label="Dismiss demo data notice" className="banner-dismiss" onClick={() => setDemoBannerVisible(false)} type="button">×</button>
          </div>}

          {runError && apiMode && <div className="inline-error" role="alert">{runError}</div>}
          {view === 'overview' && <Overview apiData={apiMode} apiRuns={apiRuns} coverage={coverage} onNavigate={setView} onOpenRun={openRun} onRun={requestRun} runs={displayRuns} stats={apiStats} trend={trend} />}
          {view === 'dashboard' && <Dashboard apiData={apiMode} apiRuns={apiRuns} composerOpen={runComposerOpen} onCancelRun={() => setRunComposerOpen(false)} onOpenRun={openRun} onRun={requestRun} onSubmitRun={submitRun} runBusy={runBusy} runComposerError={runComposerError} runs={displayRuns} stats={apiStats} trend={trend} />}
          {view === 'run' && <RunDetail apiRun={apiMode ? selectedApiRun : null} loading={apiMode && runsLoading && !selectedApiRun} onBack={() => setView('dashboard')} run={selectedRun} />}
        </main>
      </div>
      {authOpen && <AuthPanel api={api} onClose={() => setAuthOpen(false)} onSignedIn={setSignedIn} />}
    </div>
  )
}

function ProjectBar({
  apiStatus,
  error,
  loading,
  onCreate,
  onOpenAuth,
  onSelect,
  projects,
  selectedProjectId,
  session,
}: {
  apiStatus: 'checking' | 'online' | 'offline'
  error: string
  loading: boolean
  onCreate: (name: string, description: string) => Promise<void>
  onOpenAuth: () => void
  onSelect: (projectId: string) => void
  projects: ApiProject[]
  selectedProjectId: string | null
  session: Session | null
}) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    try {
      await onCreate(name, description)
      setName('')
      setDescription('')
      setCreating(false)
    } catch {
      // The parent keeps the API error visible in this bar.
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="project-bar" aria-label="Project workspace">
      <div className="project-bar-copy">
        <span className="section-kicker">Project workspace</span>
        <strong>{session ? selectedProjectId ? 'Persisted evaluation project' : 'Choose a project to begin' : 'Sign in for persisted projects'}</strong>
        <span>{session ? 'Runs are scoped to one authenticated project.' : 'The local demo remains available without an API session.'}</span>
      </div>
      {!session ? (
        <button className="button button-secondary" onClick={onOpenAuth} type="button"><Icon name="shield" size={14} /> Sign in or register</button>
      ) : creating ? (
        <form className="project-create-form" onSubmit={submit}>
          <input aria-label="Project name" onChange={(event) => setName(event.target.value)} placeholder="Project name" required value={name} />
          <input aria-label="Project description" onChange={(event) => setDescription(event.target.value)} placeholder="Description (optional)" value={description} />
          <button className="button button-primary" disabled={busy || apiStatus !== 'online'} type="submit">{busy ? 'Creating…' : 'Create'}</button>
          <button className="button button-quiet" onClick={() => setCreating(false)} type="button">Cancel</button>
        </form>
      ) : (
        <div className="project-bar-actions">
          <label className="project-select-label">
            <span className="sr-only">Selected project</span>
            <select disabled={loading || !projects.length} onChange={(event) => onSelect(event.target.value)} value={selectedProjectId ?? ''}>
              {!projects.length && <option value="">{loading ? 'Loading projects…' : 'No projects yet'}</option>}
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <Icon name="chevron-down" size={14} />
          </label>
          <button className="button button-secondary" disabled={apiStatus !== 'online'} onClick={() => setCreating(true)} type="button"><Icon name="layers" size={14} /> New project</button>
        </div>
      )}
      {error && <span className="project-error" role="alert">{error}</span>}
    </section>
  )
}

function AuthPanel({ api, onClose, onSignedIn }: { api: ApiClient; onClose: () => void; onSignedIn: (session: Session) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const result = mode === 'login' ? await api.login(email, password) : await api.register(email, password)
      onSignedIn({ token: result.access_token, user: result.user })
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'The API could not authenticate this account.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section aria-labelledby="auth-title" aria-modal="true" className="auth-panel" role="dialog">
        <button aria-label="Close authentication dialog" className="auth-close" onClick={onClose} type="button">×</button>
        <span className="eyebrow"><Icon name="shield" size={14} /> Protected workspace</span>
        <h2 id="auth-title">{mode === 'login' ? 'Sign in to VerityBench' : 'Create your workspace'}</h2>
        <p className="auth-description">Protected projects and reports are authorized server-side. No credentials are sent to the sample agent.</p>
        <form onSubmit={submit}>
          <label>Email<input autoComplete="email" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} /></label>
          <label>Password<input autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={12} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></label>
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button className="button button-primary auth-submit" disabled={busy} type="submit">{busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Register'}</button>
        </form>
        <button className="auth-switch" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError('') }} type="button">{mode === 'login' ? 'Need an account? Register' : 'Already registered? Sign in'}</button>
      </section>
    </div>
  )
}

function PageIntro({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="page-intro">
      <div>
        <span className="eyebrow"><span className="eyebrow-line" />{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  )
}

function Overview({ apiData, apiRuns, coverage, onNavigate, onOpenRun, onRun, runs, stats, trend }: { apiData: boolean; apiRuns: ApiRun[]; coverage: CoverageItem[]; onNavigate: (view: View) => void; onOpenRun: (id: string) => void; onRun: () => void; runs: Run[]; stats: DashboardStats; trend: TrendPoint[] }) {
  return (
    <>
      <section className="hero-grid">
        <div className="hero-copy">
          <span className="eyebrow"><Icon name="sparkles" size={14} /> Agent reliability workspace</span>
          <h1>Test agents. <span>Trust the evidence.</span></h1>
          <p>Exercise agent workflows against controlled failures, then verify observable outcomes instead of trusting the agent's success claim.</p>
          <div className="hero-actions">
            <button className="button button-primary" onClick={() => onNavigate('dashboard')} type="button">Explore runs <Icon name="arrow-right" size={16} /></button>
            <button className="button button-secondary" disabled={!runs.length} onClick={() => runs.length && onOpenRun(runs[0].id)} type="button"><Icon name="play" size={14} /> Open latest run</button>
          </div>
          <div className="hero-meta">
            <span><Icon name="check" size={14} /> deterministic sample suite</span>
            <span><Icon name="shield" size={14} /> independent ledger checks</span>
          </div>
        </div>
        <PulseCard apiData={apiData} runs={runs} stats={stats} trend={trend} />
      </section>

      <div className="section-heading overview-heading">
        <div><span className="section-kicker">At a glance</span><h2>Signal, without the noise</h2></div>
        <button className="text-button" onClick={() => onNavigate('dashboard')} type="button">View full dashboard <Icon name="arrow-up-right" size={15} /></button>
      </div>

      <div className="metric-grid">
        <MetricCard label="Evaluation pass rate" value={stats.passRate} change={stats.passCount} detail={apiData ? 'persisted report evaluations' : 'local sample scenarios'} icon="gauge" tone="cyan" />
        <MetricCard label="Recorded traces" value={stats.traceCount} change={apiData ? 'report-derived' : 'actual'} detail={apiData ? 'events in selected project' : 'events across demo runs'} icon="layers" tone="violet" />
        <MetricCard label="Duplicate charges" value={stats.duplicateCharges} change={apiData ? 'report-derived' : 'blocked'} detail={apiData ? 'from persisted report metrics' : 'independent evaluator finding'} icon="shield" tone="green" />
      </div>

      <div className="overview-columns">
        <RecentRuns apiData={apiData} onOpenRun={onOpenRun} runs={runs} />
        <CoveragePanel apiData={apiData} items={coverage} />
      </div>

      <section className="insight-strip">
        <div className="insight-icon"><Icon name="trend-up" size={19} /></div>
        <div>
          <span className="section-kicker">Evidence insight</span>
          <h3>{apiData ? 'Run the sample agent to create a persisted report.' : 'The defective agent created two charges after a lost response.'}</h3>
          <p>{apiData ? 'Choose safe or defective behavior and inspect the stored ledger and trace after execution.' : 'Open the failed fixture to inspect ledger entries and the idempotency recommendation.'}</p>
        </div>
        <button className="text-button" onClick={apiData ? onRun : () => runs.length && onOpenRun(runs[0].id)} type="button">{apiData ? 'Run sample agent' : 'Inspect evidence'} <Icon name="arrow-right" size={15} /></button>
      </section>
      {apiData && apiRuns.length === 0 && <EmptyState title="No persisted runs yet" description="Start a safe or defective sample agent run from the dashboard." actionLabel="Open run controls" onAction={onRun} />}
    </>
  )
}

function PulseCard({ apiData, runs, stats, trend }: { apiData: boolean; runs: Run[]; stats: DashboardStats; trend: TrendPoint[] }) {
  const chart = trend.length ? trend : demoTrend
  const points = chart.map((point, index) => `${(index / Math.max(1, chart.length - 1)) * 440},${104 - point.value * 0.9}`).join(' ')
  const latest = apiData ? stats.passRate : '100%'
  return (
    <div className="pulse-card">
      <div className="pulse-orbit orbit-one" /><div className="pulse-orbit orbit-two" />
      <div className="pulse-card-top"><span className="card-label"><span className="live-dot" /> {apiData ? 'Persisted evaluation pulse' : 'Reliability pulse'}</span><button aria-label="Pulse card options" className="icon-button subtle-icon" type="button"><Icon name="more" size={18} /></button></div>
      <div className="pulse-score">{latest.replace('%', '')}<span>{latest === '—' ? '' : '%'}</span></div>
      <div className="pulse-score-label">{apiData ? `${runs.length} report${runs.length === 1 ? '' : 's'} in selected project` : 'Safe timeout recovery verified'}</div>
      <div className="pulse-chart" aria-label="Evaluation trend" role="img"><svg preserveAspectRatio="none" viewBox="0 0 440 112"><defs><linearGradient id="pulse-gradient" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#63e6d5" stopOpacity=".26" /><stop offset="100%" stopColor="#63e6d5" stopOpacity="0" /></linearGradient></defs><polyline fill="url(#pulse-gradient)" points={`0,112 ${points} 440,112`} /><polyline fill="none" points={points} stroke="#63e6d5" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" /></svg></div>
      <div className="pulse-footer"><span><Icon name="check" size={14} /> {apiData ? 'derived from reports' : 'ledger verified'}</span><span>{apiData ? 'selected project' : 'deterministic run'}</span></div>
    </div>
  )
}

function MetricCard({ label, value, change, detail, icon, tone }: { label: string; value: string; change: string; detail: string; icon: IconName; tone: string }) {
  return <div className="metric-card"><div className={`metric-icon metric-icon-${tone}`}><Icon name={icon} size={18} /></div><div className="metric-label">{label}</div><div className="metric-value-row"><strong>{value}</strong><span className="metric-change">{change}</span></div><div className="metric-detail">{detail}</div></div>
}

function RecentRuns({ apiData, onOpenRun, runs }: { apiData: boolean; onOpenRun: (id: string) => void; runs: Run[] }) {
  return <section className="panel recent-panel"><div className="panel-heading"><div><span className="section-kicker">Activity</span><h2>{apiData ? 'Persisted runs' : 'Recent demo runs'}</h2></div>{runs[0] && <button aria-label="Open latest run" className="icon-button subtle-icon" onClick={() => onOpenRun(runs[0].id)} type="button"><Icon name="arrow-up-right" size={17} /></button>}</div><div className="run-list">{runs.length ? runs.slice(0, 3).map((run) => <RunRow key={run.id} run={run} onOpen={onOpenRun} />) : <EmptyPanel description="No persisted reports are available for this project yet." />}</div><button className="panel-footer-button" onClick={() => runs.length && onOpenRun(runs[0].id)} type="button">See all evaluation runs <Icon name="arrow-right" size={15} /></button></section>
}

function RunRow({ run, onOpen }: { run: Run; onOpen: (id: string) => void }) {
  return <button className={`run-row ${run.status === 'needs-review' ? 'run-row-needs-review' : ''}`} onClick={() => onOpen(run.id)} type="button"><span className="run-type-icon"><Icon name={run.status === 'needs-review' ? 'warning' : 'activity'} size={16} /></span><span className="run-row-copy"><strong>{run.name}</strong><span>{run.id} · {run.model}</span></span><span className="run-row-score"><strong>{formatScore(run.score)}</strong><span className={run.scoreDelta !== null && run.scoreDelta >= 0 ? 'positive' : run.scoreDelta !== null ? 'negative' : ''}>{run.scoreDelta === null ? 'report-derived' : `${run.scoreDelta >= 0 ? '+' : ''}${run.scoreDelta}%`}</span></span><Icon name="chevron-right" size={16} className="row-chevron" /></button>
}

function CoveragePanel({ apiData, items }: { apiData: boolean; items: CoverageItem[] }) {
  return <section className="panel coverage-panel"><div className="panel-heading"><div><span className="section-kicker">Evaluator coverage</span><h2>{apiData ? 'Persisted invariant signals' : 'Where confidence lives'}</h2></div><button aria-label="Coverage options" className="icon-button subtle-icon" type="button"><Icon name="more" size={17} /></button></div><div className="coverage-list">{items.length ? items.map((item) => <CoverageBar item={item} key={item.label} />) : <EmptyPanel description="Coverage appears after the first persisted report." />}</div><div className="coverage-note"><Icon name="shield" size={15} /> <span>{apiData ? 'Values are derived from report evaluation invariants.' : 'All signals are from deterministic local fixtures.'}</span></div></section>
}

function CoverageBar({ item }: { item: CoverageItem }) {
  return <div className="coverage-row"><div className="coverage-label"><span>{item.label}</span><strong>{item.value}%</strong></div><div aria-label={`${item.label}: ${item.value} percent`} aria-valuemax={100} aria-valuemin={0} aria-valuenow={item.value} className="progress-track" role="progressbar"><span className={`progress-fill fill-${item.color}`} style={{ width: `${item.value}%` }} /></div></div>
}

function Dashboard({ apiData, apiRuns, composerOpen, onCancelRun, onOpenRun, onRun, onSubmitRun, runBusy, runComposerError, runs, stats, trend }: { apiData: boolean; apiRuns: ApiRun[]; composerOpen: boolean; onCancelRun: () => void; onOpenRun: (id: string) => void; onRun: () => void; onSubmitRun: (agent: SupportedAgent, scenario: SupportedScenario) => Promise<void>; runBusy: boolean; runComposerError: string; runs: Run[]; stats: DashboardStats; trend: TrendPoint[] }) {
  return <><PageIntro eyebrow="Agent reliability workspace" title="Agent runs" description="Replay controlled scenarios and inspect the evidence behind every outcome." action={<button className="button button-primary" onClick={onRun} type="button"><Icon name="play" size={14} /> Run sample agent</button>} />{composerOpen && <RunComposer busy={runBusy} error={runComposerError} onCancel={onCancelRun} onSubmit={onSubmitRun} />}
    <div className="metric-grid dashboard-metrics"><MetricCard label="Evaluation pass rate" value={apiData ? stats.passRate : '75%'} change={apiData ? stats.passCount : '3 / 4'} detail={apiData ? 'persisted report evaluations' : 'local sample scenarios'} icon="gauge" tone="cyan" /><MetricCard label="Recorded traces" value={apiData ? stats.traceCount : '30'} change={apiData ? 'report-derived' : 'actual'} detail={apiData ? 'events in selected project' : 'events across demo runs'} icon="activity" tone="violet" /><MetricCard label="Duplicate charges" value={apiData ? stats.duplicateCharges : '01'} change={apiData ? 'report-derived' : 'blocked'} detail={apiData ? 'from persisted report metrics' : 'independent evaluator finding'} icon="warning" tone="amber" /><MetricCard label="Safe retests" value={apiData ? stats.safeRetests : '03'} change={apiData ? 'report-derived' : 'passed'} detail={apiData ? 'passed safe reports' : 'with ledger evidence'} icon="check" tone="green" /></div>
    <div className="dashboard-grid"><TrendPanel apiData={apiData} points={trend} /><ModelPanel apiData={apiData} runs={apiRuns} /></div>
    <section className="panel runs-table-panel"><div className="panel-heading table-heading"><div><span className="section-kicker">{apiData ? 'Authenticated project' : 'Deterministic sample suite'}</span><h2>{apiData ? 'Persisted agent runs' : 'All demo runs'}</h2></div><div className="table-actions"><span className="muted-label">{runs.length} {apiData ? 'loaded' : 'fixtures'}</span></div></div><div className="runs-table-wrap"><table className="runs-table"><thead><tr><th>Run</th><th>Agent</th><th>Scenario</th><th>Status</th><th>Report score</th><th>Completed</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{runs.length ? runs.map((run) => <tr key={run.id} onClick={() => onOpenRun(run.id)}><td><button className="table-run-name" onClick={(event) => { event.stopPropagation(); onOpenRun(run.id) }} type="button"><span className="table-run-icon"><Icon name="activity" size={14} /></span><span><strong>{run.name}</strong><small>{run.id}</small></span></button></td><td>{run.model}<small>{run.modelVersion}</small></td><td>{run.dataset}</td><td><StatusBadge status={run.status} /></td><td><strong className="table-score">{formatScore(run.score)}</strong><small>{run.scoreDelta === null ? 'derived from report' : `${run.scoreDelta >= 0 ? '+' : ''}${run.scoreDelta}% vs. prior`}</small></td><td className="muted-cell">{run.completedAt}</td><td><button aria-label={`Open ${run.name}`} className="icon-button subtle-icon" onClick={(event) => { event.stopPropagation(); onOpenRun(run.id) }} type="button"><Icon name="chevron-right" size={16} /></button></td></tr>) : <tr><td className="table-empty" colSpan={7}><EmptyPanel description={apiData ? 'No persisted runs in this project yet.' : 'Demo fixtures are unavailable.'} /></td></tr>}</tbody></table></div></section>
  </>
}

function RunComposer({ busy, error, onCancel, onSubmit }: { busy: boolean; error: string; onCancel: () => void; onSubmit: (agent: SupportedAgent, scenario: SupportedScenario) => Promise<void> }) {
  const [agent, setAgent] = useState<SupportedAgent>('safe')
  const [scenario, setScenario] = useState<SupportedScenario>('normal')
  const selectedScenario = scenarios.find((item) => item.value === scenario)
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void onSubmit(agent, scenario)
  }
  return <section className="panel run-composer"><div className="panel-heading"><div><span className="section-kicker">Protected sample execution</span><h2>Configure a persisted run</h2></div><button aria-label="Close run controls" className="icon-button subtle-icon" onClick={onCancel} type="button">×</button></div><p className="composer-description">Only the repository-owned safe and defective sample agents can execute. The selected scenario is persisted with its evidence report.</p><form className="composer-form" onSubmit={submit}><label>Agent<select onChange={(event) => setAgent(event.target.value as SupportedAgent)} value={agent}><option value="safe">safe-sample-agent · reconciles uncertainty</option><option value="defective">defective-sample-agent · demonstrates duplicate charge</option></select></label><label>Scenario<select onChange={(event) => setScenario(event.target.value as SupportedScenario)} value={scenario}>{scenarios.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select><span className="field-help">{selectedScenario?.description}</span></label><div className="composer-actions"><button className="button button-primary" disabled={busy} type="submit"><Icon name="play" size={14} /> {busy ? 'Running…' : 'Run and persist report'}</button><button className="button button-quiet" onClick={onCancel} type="button">Cancel</button></div></form>{error && <p className="auth-error" role="alert">{error}</p>}</section>
}

function TrendPanel({ apiData, points }: { apiData: boolean; points: TrendPoint[] }) {
  const chartPoints = points.length ? points : apiData ? [] : demoTrend
  const coordinates = chartPoints.map((point, index) => `${(index / Math.max(1, chartPoints.length - 1)) * 100},${104 - point.value}`).join(' ')
  return <section className="panel trend-panel"><div className="panel-heading"><div><span className="section-kicker">{apiData ? 'Persisted report history' : 'Quality over time'}</span><h2>{apiData ? 'Evaluation history' : 'Score trend'}</h2></div><span className="chart-period">{apiData ? `${chartPoints.length} reports` : 'Local suite'} <Icon name="chevron-down" size={14} /></span></div>{chartPoints.length ? <><div className="trend-summary"><strong>{formatScore(chartPoints[chartPoints.length - 1].value)}</strong><span className="positive"><Icon name="trend-up" size={14} /> {apiData ? 'latest report-derived score' : 'safe paths pass'}</span></div><div className="trend-chart"><div className="chart-y-labels"><span>100</span><span>75</span><span>50</span><span>0</span></div><svg preserveAspectRatio="none" viewBox="0 0 100 104" aria-label="Evaluation score trend" role="img"><defs><linearGradient id="trend-gradient" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#7a8cff" stopOpacity=".22" /><stop offset="100%" stopColor="#7a8cff" stopOpacity="0" /></linearGradient></defs><polygon fill="url(#trend-gradient)" points={`0,104 ${coordinates} 100,104`} /><polyline fill="none" points={coordinates} stroke="#8b9aff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4" /></svg></div><div className="chart-x-labels">{chartPoints.map((point) => <span key={point.label}>{point.label}</span>)}</div></> : <EmptyPanel description="Run a sample agent to build persisted evaluation history." />}</section>
}

function ModelPanel({ apiData, runs }: { apiData: boolean; runs: ApiRun[] }) {
  const models = apiData ? Array.from(new Set(runs.map((run) => run.report?.agent_name ?? `${run.agent}-sample-agent`))).map((name) => {
    const modelRuns = runs.filter((run) => (run.report?.agent_name ?? `${run.agent}-sample-agent`) === name)
    const scores = modelRuns.map((run) => runScore(run.report)).filter((score): score is number => score !== null)
    return { name, score: scores.length ? Math.round(scores.reduce((total, score) => total + score, 0) / scores.length) : null, cases: `${modelRuns.length} persisted run${modelRuns.length === 1 ? '' : 's'}`, color: name.includes('defective') ? 'amber' : 'cyan' }
  }) : [{ name: 'safe-sample-agent', score: 100, cases: '3 safe paths', color: 'cyan' }, { name: 'defective-sample-agent', score: 0, cases: '1 defect path', color: 'amber' }]
  return <section className="panel model-panel"><div className="panel-heading"><div><span className="section-kicker">Agent comparison</span><h2>{apiData ? 'By persisted report' : 'By integration'}</h2></div><button aria-label="Agent comparison options" className="icon-button subtle-icon" type="button"><Icon name="more" size={17} /></button></div><div className="model-list">{models.length ? models.map((model) => <div className="model-row" key={model.name}><span className={`model-bullet bullet-${model.color}`} /><span className="model-name"><strong>{model.name}</strong><small>{model.cases}</small></span><span className="model-score"><strong>{formatScore(model.score)}</strong><span className="mini-track"><span className={`mini-fill fill-${model.color}`} style={{ width: `${model.score ?? 0}%` }} /></span></span></div>) : <EmptyPanel description="No persisted reports to compare." />}</div><div className="model-footer"><span><span className="legend-dot dot-cyan" /> {apiData ? 'Average derived from reports' : 'Best performing'}</span><span>{apiData ? 'selected project' : 'Local demo snapshot'}</span></div></section>
}

function RunDetail({ apiRun, loading, onBack, run }: { apiRun: ApiRun | null; loading: boolean; onBack: () => void; run: Run | null }) {
  if (apiRun) return <ApiRunDetail apiRun={apiRun} onBack={onBack} />
  if (loading) return <><button className="back-button" onClick={onBack} type="button"><Icon name="arrow-left" size={16} /> Back to runs</button><div className="detail-loading">Loading persisted report…</div></>
  if (!run) return <><button className="back-button" onClick={onBack} type="button"><Icon name="arrow-left" size={16} /> Back to runs</button><EmptyState title="Run not found" description="This run is not available in the selected project." actionLabel="Back to runs" onAction={onBack} /></>
  return <DemoRunDetail onBack={onBack} run={run} />
}

function DemoRunDetail({ onBack, run }: { onBack: () => void; run: Run }) {
  const score = run.score ?? 0
  return <><button className="back-button" onClick={onBack} type="button"><Icon name="arrow-left" size={16} /> Back to runs</button><div className="run-detail-header"><div><div className="run-id-line"><span className="run-id-badge">{run.id}</span><StatusBadge status={run.status} /></div><h1>{run.name}</h1><p>{run.model} <span>·</span> {run.dataset} <span>·</span> {run.completedAt}</p></div><div className="run-detail-actions"><button className="button button-quiet" type="button"><Icon name="download" size={15} /> Export</button><button className="button button-secondary" type="button"><Icon name="external-link" size={15} /> Open trace</button></div></div><div className="run-summary-grid"><div className="run-score-card"><span className="section-kicker">Overall score</span><strong>{score}<small>%</small></strong><span className="positive"><Icon name="trend-up" size={14} /> {run.scoreDelta ?? 0}% vs. prior run</span></div><div className="run-summary-card"><span className="summary-card-icon icon-green"><Icon name="check" size={16} /></span><span className="section-kicker">Passed cases</span><strong>{formatNumber(run.passedCases)} <small>/ {formatNumber(run.cases)}</small></strong><span>{Math.round((run.passedCases / run.cases) * 100)}% pass rate</span></div><div className="run-summary-card"><span className="summary-card-icon icon-violet"><Icon name="clock" size={16} /></span><span className="section-kicker">Duration</span><strong>{run.duration}</strong><span>Local deterministic fixture</span></div></div><div className="run-detail-grid"><section className="panel evaluators-panel"><div className="panel-heading"><div><span className="section-kicker">Independent checks</span><h2>Evaluator breakdown</h2></div><span className="muted-label">{demoEvaluators.length} invariants</span></div><div className="evaluator-list">{demoEvaluators.map((evaluator) => <EvaluatorRow evaluator={evaluator} key={evaluator.name} />)}</div></section><section className="panel config-panel"><div className="panel-heading"><div><span className="section-kicker">Run context</span><h2>Configuration</h2></div></div><dl className="config-list"><div><dt>Agent</dt><dd>{run.model}<small>{run.modelVersion}</small></dd></div><div><dt>Scenario</dt><dd>{run.dataset}<small>deterministic simulated payment</small></dd></div><div><dt>Evidence</dt><dd>ledger + trace<small>independent evaluator</small></dd></div><div><dt>Execution</dt><dd><span className="environment-dot" /> Local safe mode<small>untrusted code disabled</small></dd></div></dl></section></div><section className="evidence-panel"><div className="evidence-mark"><Icon name="shield" size={18} /></div><div><span className="section-kicker">Evidence preview</span><h2>Every result should be explainable.</h2><p>Trace-level events, ledger entries, failed invariants, and grounded recommendations are derived from deterministic local fixtures.</p></div><span className="text-button">Demo evidence <Icon name="check" size={14} /></span></section></>
}

function ApiRunDetail({ apiRun, onBack }: { apiRun: ApiRun; onBack: () => void }) {
  const report = apiRun.report
  if (!report) return <><button className="back-button" onClick={onBack} type="button"><Icon name="arrow-left" size={16} /> Back to runs</button><div className="inline-error" role="alert">This persisted run has no report. {apiRun.error_message ?? 'The API did not return an execution report.'}</div></>
  const score = runScore(report)
  const evaluation = report.evaluation
  return <><button className="back-button" onClick={onBack} type="button"><Icon name="arrow-left" size={16} /> Back to runs</button><div className="run-detail-header"><div><div className="run-id-line"><span className="run-id-badge">{apiRun.id}</span><StatusBadge status={apiRun.state === 'passed' ? 'completed' : apiRun.state === 'failed' ? 'needs-review' : 'running'} /></div><h1>{report.agent_name}</h1><p>{formatScenario(apiRun.scenario)} <span>·</span> {formatDate(apiRun.completed_at ?? apiRun.created_at)} <span>·</span> persisted API report</p></div><div className="run-detail-actions"><button className="button button-quiet" onClick={() => downloadReport(apiRun)} type="button"><Icon name="download" size={15} /> Export JSON</button></div></div><div className="run-summary-grid"><div className={`run-score-card ${evaluation.passed ? '' : 'run-score-card-failed'}`}><span className="section-kicker">Report evaluation</span><strong>{score === null ? '—' : `${score}`}<small>{score === null ? '' : '%'}</small></strong><span className={evaluation.passed ? 'positive' : 'negative'}><Icon name={evaluation.passed ? 'check' : 'warning'} size={14} /> {evaluation.passed ? 'all invariants passed' : `${evaluation.findings.length} finding${evaluation.findings.length === 1 ? '' : 's'} recorded`}</span></div><div className="run-summary-card"><span className="summary-card-icon icon-violet"><Icon name="activity" size={16} /></span><span className="section-kicker">Trace events</span><strong>{formatNumber(report.trace.length)}</strong><span>from persisted report.trace</span></div><div className="run-summary-card"><span className="summary-card-icon icon-green"><Icon name="database" size={16} /></span><span className="section-kicker">Ledger entries</span><strong>{formatNumber(report.ledger.entries.length)}</strong><span>{report.order.status} final order state</span></div></div><div className="metric-grid report-metrics"><MetricCard label="Payment attempts" value={formatNumber(report.metrics.payment_attempts)} change="report.metrics" detail="derived by engine" icon="activity" tone="violet" /><MetricCard label="Ledger charges" value={formatNumber(report.metrics.ledger_charges)} change="report.metrics" detail="observable settlements" icon="database" tone="green" /><MetricCard label="Duplicate charges" value={formatNumber(report.metrics.duplicate_charges)} change="report.metrics" detail="independent ledger check" icon="warning" tone="amber" /><MetricCard label="Reconciliations" value={formatNumber(report.metrics.reconciliations)} change="report.metrics" detail="observable recovery events" icon="shield" tone="cyan" /></div><div className="run-detail-grid"><section className="panel evaluators-panel"><div className="panel-heading"><div><span className="section-kicker">Persisted evaluation.invariants</span><h2>Evaluator breakdown</h2></div><span className="muted-label">{evaluation.invariants.length} invariants</span></div><div className="evaluator-list">{evaluation.invariants.map((invariant) => <ApiInvariantRow invariant={invariant} key={invariant.name} />)}</div></section><section className="panel config-panel"><div className="panel-heading"><div><span className="section-kicker">Persisted run context</span><h2>Configuration</h2></div></div><dl className="config-list"><div><dt>Agent</dt><dd>{report.agent_name}<small>{apiRun.agent} integration</small></dd></div><div><dt>Scenario</dt><dd>{formatScenario(apiRun.scenario)}<small>persisted request value</small></dd></div><div><dt>Order</dt><dd>{report.order.order_id}<small>{report.order.amount} {report.order.currency} · {report.order.status}</small></dd></div><div><dt>Execution</dt><dd><span className="environment-dot environment-dot-live" /> API sample run<small>repository-owned agent only</small></dd></div></dl></section></div><ApiEvidence report={report} /><section className="panel findings-panel"><div className="panel-heading"><div><span className="section-kicker">Persisted evaluation.findings</span><h2>Grounded recommendations</h2></div><span className="muted-label">{evaluation.findings.length} findings</span></div>{evaluation.findings.length ? <div className="finding-list">{evaluation.findings.map((finding) => <article className={`finding-card finding-${finding.severity}`} key={finding.code}><div className="finding-heading"><span className="finding-severity">{finding.severity}</span><strong>{finding.title}</strong><span className="finding-code">{finding.code}</span></div><p>{finding.recommendation}</p><ul>{finding.evidence.map((evidence) => <li key={evidence}>{evidence}</li>)}</ul></article>)}</div> : <EmptyPanel description="The persisted evaluator recorded no findings." />}</section><details className="raw-report"><summary>Inspect persisted report JSON</summary><pre>{JSON.stringify(report, null, 2)}</pre></details></>
}

function ApiInvariantRow({ invariant }: { invariant: ApiEvaluation['invariants'][number] }) {
  return <div className="evaluator-row"><span className={`evaluator-icon ${invariant.passed ? 'evaluator-pass' : 'evaluator-attention'}`}><Icon name={invariant.passed ? 'check' : 'warning'} size={15} /></span><span className="evaluator-copy"><strong>{invariant.name}</strong><span>{invariant.evidence.length ? invariant.evidence.join(' · ') : 'No evidence recorded.'}</span></span><span className={`evaluator-score ${invariant.passed ? 'positive' : 'negative'}`}><strong>{invariant.passed ? 'PASS' : 'FAIL'}</strong><small>{invariant.evidence.length} evidence</small></span></div>
}

function ApiEvidence({ report }: { report: ApiReport }) {
  return <section className="panel api-evidence-panel"><div className="panel-heading"><div><span className="section-kicker">Persisted evidence</span><h2>Ledger and trace</h2></div><span className="muted-label">report JSON</span></div><div className="evidence-columns"><div><h3>Ledger entries</h3>{report.ledger.entries.length ? <div className="ledger-list">{report.ledger.entries.map((entry) => <div className="ledger-entry" key={entry.entry_id}><span className="ledger-entry-icon"><Icon name={entry.entry_type === 'charge' ? 'database' : 'arrow-right'} size={14} /></span><span><strong>{entry.entry_id}</strong><small>{entry.entry_type} · {entry.payment_id} · key {entry.idempotency_key}</small></span><b>{entry.amount} {entry.currency}</b></div>)}</div> : <EmptyPanel description="No ledger entries recorded." />}</div><div><h3>Trace events</h3>{report.trace.length ? <div className="trace-list">{report.trace.map((event) => <div className="trace-entry" key={`${event.index}-${event.event_type}`}><span className="trace-index">{String(event.index).padStart(2, '0')}</span><span><strong>{event.event_type}</strong><small>{formatAttributes(event.attributes)}</small></span></div>)}</div> : <EmptyPanel description="No trace events recorded." />}</div></div></section>
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
  anchor.href = url
  anchor.download = `${run.id}-report.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

function EvaluatorRow({ evaluator }: { evaluator: EvaluatorResult }) {
  return <div className="evaluator-row"><span className={`evaluator-icon ${evaluator.status === 'passed' ? 'evaluator-pass' : 'evaluator-attention'}`}><Icon name={evaluator.status === 'passed' ? 'check' : 'warning'} size={15} /></span><span className="evaluator-copy"><strong>{evaluator.name}</strong><span>{evaluator.description}</span></span><span className="evaluator-score"><strong>{evaluator.score}%</strong><small>{evaluator.passed}/{evaluator.total}</small></span><Icon name="chevron-right" size={16} className="row-chevron" /></div>
}

function EmptyPanel({ description }: { description: string }) {
  return <div className="empty-panel"><Icon name="layers" size={18} /><span>{description}</span></div>
}

function EmptyState({ title, description, actionLabel, onAction }: { title: string; description: string; actionLabel: string; onAction: () => void }) {
  return <section className="empty-state"><span className="empty-state-icon"><Icon name="layers" size={21} /></span><h2>{title}</h2><p>{description}</p><button className="button button-secondary" onClick={onAction} type="button">{actionLabel} <Icon name="arrow-right" size={14} /></button></section>
}

function App() {
  return <BrowserRouter><Workspace /></BrowserRouter>
}

export default App
