import { useEffect, useMemo, useState } from 'react'
import { demoCoverage, demoEvaluators, demoRuns, demoTrend } from './data/demo'
import { Icon, type IconName } from './components/Icon'
import type { CoverageItem, EvaluatorResult, Run, View } from './types'
import { createApiClient, type ApiClient } from './lib/api'
import { BrowserRouter, useLocation, useNavigate } from 'react-router-dom'

const navItems: Array<{ id: View; label: string; icon: IconName }> = [
  { id: 'overview', label: 'Overview', icon: 'layers' },
  { id: 'dashboard', label: 'Agent runs', icon: 'activity' },
]

const viewLabels: Record<View, string> = {
  overview: 'Overview',
  dashboard: 'Agent runs',
  run: 'Run detail',
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('en-US').format(value)
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

function DemoPill({ apiStatus }: { apiStatus: 'checking' | 'online' | 'offline' }) {
  const label = apiStatus === 'online' ? 'API connected' : apiStatus === 'checking' ? 'Checking API' : 'Local demo'
  return (
    <span className="demo-pill">
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
  const selectedRunId = location.pathname.startsWith('/runs/') ? decodeURIComponent(location.pathname.slice('/runs/'.length)) : demoRuns[0].id
  const [apiStatus, setApiStatus] = useState<'checking' | 'online' | 'offline'>('checking')
  const [authOpen, setAuthOpen] = useState(false)
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const selectedRun = useMemo(
    () => demoRuns.find((run) => run.id === selectedRunId) ?? demoRuns[0],
    [selectedRunId],
  )

  const setView = (nextView: View) => navigate(nextView === 'overview' ? '/' : '/runs')
  const openRun = (runId: string) => {
    navigate(`/runs/${encodeURIComponent(runId)}`)
  }

  useEffect(() => {
    let active = true
    api.getHealth().then(() => active && setApiStatus('online')).catch(() => active && setApiStatus('offline'))
    return () => { active = false }
  }, [api])

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
          <span className="workspace-avatar">V</span>
          <span className="workspace-copy">
            <span className="workspace-label">Workspace</span>
            <strong>sample workspace</strong>
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
              {item.id === 'dashboard' && <span className="nav-count">04</span>}
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
              <span>Monthly usage</span>
              <span className="usage-value">32%</span>
            </div>
            <div aria-label="Monthly usage: 32 percent" aria-valuemax={100} aria-valuemin={0} aria-valuenow={32} className="progress-track" role="progressbar">
              <span className="progress-fill usage-fill" />
            </div>
             <span className="usage-footnote">4 scenarios in local suite</span>
          </div>
          <div className="user-row">
            <span className="user-avatar">AV</span>
            <span className="user-copy">
              <strong>Alex V.</strong>
              <span>Admin</span>
            </span>
            <Icon name="more" size={18} />
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
            <DemoPill apiStatus={apiStatus} />
            <button aria-label="Search" className="search-button" type="button">
              <Icon name="search" size={16} />
              <span>Search</span>
              <kbd>⌘ K</kbd>
            </button>
            <button aria-label="Open notifications" className="icon-button notification-button" type="button">
              <Icon name="activity" size={18} />
              <span className="notification-dot" />
            </button>
            <button aria-label={userEmail ? `Signed in as ${userEmail}` : 'Sign in'} className="topbar-avatar profile-button" onClick={() => setAuthOpen(true)} type="button">{userEmail ? userEmail.slice(0, 2).toUpperCase() : 'SI'}</button>
          </div>
        </header>

        <main className="page-content">
          <div className="demo-banner">
            <Icon name="sparkles" size={16} />
            <span><strong>Safe local mode</strong> · Only repository-owned sample agents run here; imported code is disabled.</span>
            <button aria-label="Dismiss demo data notice" className="banner-dismiss" type="button">×</button>
          </div>

          {view === 'overview' && <Overview onNavigate={setView} onOpenRun={openRun} />}
          {view === 'dashboard' && <Dashboard onOpenRun={openRun} />}
          {view === 'run' && <RunDetail run={selectedRun} onBack={() => setView('dashboard')} />}
        </main>
      </div>
      {authOpen && <AuthPanel api={api} onClose={() => setAuthOpen(false)} onSignedIn={(email) => { setUserEmail(email); setAuthOpen(false) }} />}
    </div>
  )
}

function AuthPanel({ api, onClose, onSignedIn }: { api: ApiClient; onClose: () => void; onSignedIn: (email: string) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const result = mode === 'login' ? await api.login(email, password) : await api.register(email, password)
      onSignedIn(result.user.email)
    } catch {
      setError('The API could not authenticate this account. Check the server and credentials.')
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

function PageIntro({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string
  title: string
  description: string
  action?: React.ReactNode
}) {
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

function Overview({ onNavigate, onOpenRun }: { onNavigate: (view: View) => void; onOpenRun: (id: string) => void }) {
  return (
    <>
      <section className="hero-grid">
        <div className="hero-copy">
          <span className="eyebrow"><Icon name="sparkles" size={14} /> Agent reliability workspace</span>
          <h1>Test agents. <span>Trust the evidence.</span></h1>
          <p>Exercise agent workflows against controlled failures, then verify observable outcomes instead of trusting the agent's success claim.</p>
          <div className="hero-actions">
            <button className="button button-primary" onClick={() => onNavigate('dashboard')} type="button">
              Explore runs <Icon name="arrow-right" size={16} />
            </button>
            <button className="button button-secondary" onClick={() => onOpenRun(demoRuns[0].id)} type="button">
              <Icon name="play" size={14} /> Open latest run
            </button>
          </div>
          <div className="hero-meta">
            <span><Icon name="check" size={14} /> deterministic sample suite</span>
            <span><Icon name="shield" size={14} /> independent ledger checks</span>
          </div>
        </div>
        <PulseCard />
      </section>

      <div className="section-heading overview-heading">
        <div>
          <span className="section-kicker">At a glance</span>
          <h2>Signal, without the noise</h2>
        </div>
        <button className="text-button" onClick={() => onNavigate('dashboard')} type="button">View full dashboard <Icon name="arrow-up-right" size={15} /></button>
      </div>

      <div className="metric-grid">
        <MetricCard label="Suite pass rate" value="75%" change="3 / 4" detail="local sample scenarios" icon="gauge" tone="cyan" />
        <MetricCard label="Recorded traces" value="30" change="actual" detail="events across demo runs" icon="layers" tone="violet" />
        <MetricCard label="Duplicate charges" value="01" change="blocked" detail="independent evaluator finding" icon="shield" tone="green" />
      </div>

      <div className="overview-columns">
        <RecentRuns onOpenRun={onOpenRun} />
        <CoveragePanel />
      </div>

      <section className="insight-strip">
        <div className="insight-icon"><Icon name="trend-up" size={19} /></div>
        <div>
          <span className="section-kicker">Evidence insight</span>
          <h3>The defective agent created two charges after a lost response.</h3>
          <p>Open the failed run to inspect ledger entries and the idempotency recommendation.</p>
        </div>
        <button className="text-button" onClick={() => onOpenRun(demoRuns[0].id)} type="button">Inspect evidence <Icon name="arrow-right" size={15} /></button>
      </section>
    </>
  )
}

function PulseCard() {
  return (
    <div className="pulse-card">
      <div className="pulse-orbit orbit-one" />
      <div className="pulse-orbit orbit-two" />
      <div className="pulse-card-top">
        <span className="card-label"><span className="live-dot" /> Reliability pulse</span>
        <button aria-label="Pulse card options" className="icon-button subtle-icon" type="button"><Icon name="more" size={18} /></button>
      </div>
      <div className="pulse-score">100<span>%</span></div>
      <div className="pulse-score-label">Safe timeout recovery verified</div>
      <div className="pulse-chart" aria-label="Score trend rising from 78 to 93 percent" role="img">
        <svg preserveAspectRatio="none" viewBox="0 0 440 112">
          <defs>
            <linearGradient id="pulse-gradient" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#63e6d5" stopOpacity=".26" />
              <stop offset="100%" stopColor="#63e6d5" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d="M0 87 C32 84 38 75 65 78 S99 86 126 68 S158 79 188 56 S222 67 250 43 S283 59 309 35 S341 43 369 26 S407 34 440 7 V112 H0Z" fill="url(#pulse-gradient)" />
          <path d="M0 87 C32 84 38 75 65 78 S99 86 126 68 S158 79 188 56 S222 67 250 43 S283 59 309 35 S341 43 369 26 S407 34 440 7" fill="none" stroke="#63e6d5" strokeWidth="2.5" />
          <circle cx="440" cy="7" fill="#63e6d5" r="4" />
        </svg>
      </div>
      <div className="pulse-footer"><span><Icon name="check" size={14} /> ledger verified</span><span>deterministic run</span></div>
    </div>
  )
}

function MetricCard({ label, value, change, detail, icon, tone }: { label: string; value: string; change: string; detail: string; icon: IconName; tone: string }) {
  return (
    <div className="metric-card">
      <div className={`metric-icon metric-icon-${tone}`}><Icon name={icon} size={18} /></div>
      <div className="metric-label">{label}</div>
      <div className="metric-value-row"><strong>{value}</strong><span className="metric-change">{change}</span></div>
      <div className="metric-detail">{detail}</div>
    </div>
  )
}

function RecentRuns({ onOpenRun }: { onOpenRun: (id: string) => void }) {
  return (
    <section className="panel recent-panel">
      <div className="panel-heading">
        <div><span className="section-kicker">Activity</span><h2>Recent runs</h2></div>
        <button className="icon-button subtle-icon" onClick={() => onOpenRun(demoRuns[0].id)} type="button"><Icon name="arrow-up-right" size={17} /></button>
      </div>
      <div className="run-list">
        {demoRuns.slice(0, 3).map((run) => <RunRow key={run.id} run={run} onOpen={onOpenRun} />)}
      </div>
      <button className="panel-footer-button" onClick={() => onOpenRun(demoRuns[0].id)} type="button">See all evaluation runs <Icon name="arrow-right" size={15} /></button>
    </section>
  )
}

function RunRow({ run, onOpen }: { run: Run; onOpen: (id: string) => void }) {
  return (
    <button className={`run-row ${run.status === 'needs-review' ? 'run-row-needs-review' : ''}`} onClick={() => onOpen(run.id)} type="button">
      <span className="run-type-icon"><Icon name={run.status === 'needs-review' ? 'warning' : 'activity'} size={16} /></span>
      <span className="run-row-copy"><strong>{run.name}</strong><span>{run.id} · {run.model}</span></span>
      <span className="run-row-score"><strong>{run.score}%</strong><span className={run.scoreDelta >= 0 ? 'positive' : 'negative'}>{run.scoreDelta >= 0 ? '+' : ''}{run.scoreDelta}%</span></span>
      <Icon name="chevron-right" size={16} className="row-chevron" />
    </button>
  )
}

function CoveragePanel() {
  return (
    <section className="panel coverage-panel">
      <div className="panel-heading">
        <div><span className="section-kicker">Evaluator coverage</span><h2>Where confidence lives</h2></div>
        <button aria-label="Coverage options" className="icon-button subtle-icon" type="button"><Icon name="more" size={17} /></button>
      </div>
      <div className="coverage-list">
        {demoCoverage.map((item) => <CoverageBar item={item} key={item.label} />)}
      </div>
       <div className="coverage-note"><Icon name="shield" size={15} /> <span>All signals are from deterministic local fixtures.</span></div>
    </section>
  )
}

function CoverageBar({ item }: { item: CoverageItem }) {
  return (
    <div className="coverage-row">
      <div className="coverage-label"><span>{item.label}</span><strong>{item.value}%</strong></div>
      <div aria-label={`${item.label}: ${item.value} percent`} aria-valuemax={100} aria-valuemin={0} aria-valuenow={item.value} className="progress-track" role="progressbar"><span className={`progress-fill fill-${item.color}`} style={{ width: `${item.value}%` }} /></div>
    </div>
  )
}

function Dashboard({ onOpenRun }: { onOpenRun: (id: string) => void }) {
  return (
    <>
       <PageIntro eyebrow="Agent reliability workspace" title="Agent runs" description="Replay controlled scenarios and inspect the evidence behind every outcome." action={<button className="button button-primary" type="button"><Icon name="play" size={14} /> Run local suite</button>} />
      <div className="metric-grid dashboard-metrics">
         <MetricCard label="Suite pass rate" value="75%" change="3 / 4" detail="local sample scenarios" icon="gauge" tone="cyan" />
         <MetricCard label="Recorded traces" value="30" change="actual" detail="events across demo runs" icon="activity" tone="violet" />
         <MetricCard label="Duplicate charges" value="01" change="blocked" detail="independent evaluator finding" icon="warning" tone="amber" />
         <MetricCard label="Safe retests" value="03" change="passed" detail="with ledger evidence" icon="check" tone="green" />
      </div>
      <div className="dashboard-grid">
        <TrendPanel />
        <ModelPanel />
      </div>
      <section className="panel runs-table-panel">
        <div className="panel-heading table-heading">
           <div><span className="section-kicker">Deterministic sample suite</span><h2>All agent runs</h2></div>
          <div className="table-actions"><button className="button button-quiet" type="button"><Icon name="sliders" size={15} /> Filter</button><button aria-label="Download runs" className="icon-button subtle-icon" type="button"><Icon name="download" size={16} /></button></div>
        </div>
        <div className="runs-table-wrap">
          <table className="runs-table">
            <thead><tr><th>Run</th><th>Model</th><th>Dataset</th><th>Status</th><th>Score</th><th>Completed</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{demoRuns.map((run) => <tr key={run.id} onClick={() => onOpenRun(run.id)}><td><button className="table-run-name" onClick={() => onOpenRun(run.id)} type="button"><span className="table-run-icon"><Icon name="activity" size={14} /></span><span><strong>{run.name}</strong><small>{run.id}</small></span></button></td><td>{run.model}<small>{run.modelVersion}</small></td><td>{run.dataset}</td><td><StatusBadge status={run.status} /></td><td><strong className="table-score">{run.score}%</strong><small className={run.scoreDelta >= 0 ? 'positive' : 'negative'}>{run.scoreDelta >= 0 ? '+' : ''}{run.scoreDelta}%</small></td><td className="muted-cell">{run.completedAt}</td><td><button aria-label={`Open ${run.name}`} className="icon-button subtle-icon" onClick={() => onOpenRun(run.id)} type="button"><Icon name="chevron-right" size={16} /></button></td></tr>)}</tbody>
          </table>
        </div>
      </section>
    </>
  )
}

function TrendPanel() {
  const points = demoTrend.map((point, index) => `${index * 16.66},${104 - (point.value - 75) * 3.3}`).join(' ')
  const areaPoints = `0,104 ${points} 100,104`
  return (
    <section className="panel trend-panel">
      <div className="panel-heading"><div><span className="section-kicker">Quality over time</span><h2>Score trend</h2></div><span className="chart-period">Last 7 days <Icon name="chevron-down" size={14} /></span></div>
      <div className="trend-summary"><strong>75%</strong><span className="positive"><Icon name="trend-up" size={14} /> safe paths pass</span></div>
      <div className="trend-chart">
        <div className="chart-y-labels"><span>100</span><span>90</span><span>80</span><span>70</span></div>
        <svg preserveAspectRatio="none" viewBox="0 0 100 104" aria-label="Seven day evaluation score trend" role="img"><defs><linearGradient id="trend-gradient" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#7a8cff" stopOpacity=".22" /><stop offset="100%" stopColor="#7a8cff" stopOpacity="0" /></linearGradient></defs><path d={`M ${areaPoints}`} fill="url(#trend-gradient)" /><polyline fill="none" points={points} stroke="#8b9aff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4" /><circle cx="100" cy="45" fill="#0d1119" r="2.7" stroke="#8b9aff" strokeWidth="1.4" /></svg>
      </div>
      <div className="chart-x-labels">{demoTrend.map((point) => <span key={point.label}>{point.label}</span>)}</div>
    </section>
  )
}

function ModelPanel() {
   const models = [{ name: 'safe-sample-agent', score: 100, cases: '3 safe paths', color: 'cyan' }, { name: 'defective-sample-agent', score: 0, cases: '1 defect path', color: 'amber' }]
  return (
    <section className="panel model-panel">
      <div className="panel-heading"><div><span className="section-kicker">Agent comparison</span><h2>By integration</h2></div><button aria-label="Agent comparison options" className="icon-button subtle-icon" type="button"><Icon name="more" size={17} /></button></div>
      <div className="model-list">{models.map((model) => <div className="model-row" key={model.name}><span className={`model-bullet bullet-${model.color}`} /><span className="model-name"><strong>{model.name}</strong><small>{model.cases} cases</small></span><span className="model-score"><strong>{model.score}%</strong><span className="mini-track"><span className={`mini-fill fill-${model.color}`} style={{ width: `${model.score}%` }} /></span></span></div>)}</div>
      <div className="model-footer"><span><span className="legend-dot dot-cyan" /> Best performing</span><span>Local demo snapshot</span></div>
    </section>
  )
}

function RunDetail({ run, onBack }: { run: Run; onBack: () => void }) {
  return (
    <>
      <button className="back-button" onClick={onBack} type="button"><Icon name="arrow-left" size={16} /> Back to runs</button>
      <div className="run-detail-header">
        <div>
          <div className="run-id-line"><span className="run-id-badge">{run.id}</span><StatusBadge status={run.status} /></div>
          <h1>{run.name}</h1>
          <p>{run.model} <span>·</span> {run.dataset} <span>·</span> {run.completedAt}</p>
        </div>
        <div className="run-detail-actions"><button className="button button-quiet" type="button"><Icon name="download" size={15} /> Export</button><button className="button button-secondary" type="button"><Icon name="external-link" size={15} /> Open trace</button></div>
      </div>
      <div className="run-summary-grid">
        <div className="run-score-card"><span className="section-kicker">Overall score</span><strong>{run.score}<small>%</small></strong><span className="positive"><Icon name="trend-up" size={14} /> {run.scoreDelta}% vs. prior run</span></div>
        <div className="run-summary-card"><span className="summary-card-icon icon-green"><Icon name="check" size={16} /></span><span className="section-kicker">Passed cases</span><strong>{formatNumber(run.passedCases)} <small>/ {formatNumber(run.cases)}</small></strong><span>{Math.round((run.passedCases / run.cases) * 100)}% pass rate</span></div>
        <div className="run-summary-card"><span className="summary-card-icon icon-violet"><Icon name="clock" size={16} /></span><span className="section-kicker">Duration</span><strong>{run.duration}</strong><span>Started today at 09:34 UTC</span></div>
      </div>
      <div className="run-detail-grid">
        <section className="panel evaluators-panel">
          <div className="panel-heading"><div><span className="section-kicker">Independent checks</span><h2>Evaluator breakdown</h2></div><span className="muted-label">4 invariants</span></div>
          <div className="evaluator-list">{demoEvaluators.map((evaluator) => <EvaluatorRow evaluator={evaluator} key={evaluator.name} />)}</div>
        </section>
        <section className="panel config-panel">
          <div className="panel-heading"><div><span className="section-kicker">Run context</span><h2>Configuration</h2></div><button aria-label="Configuration options" className="icon-button subtle-icon" type="button"><Icon name="more" size={17} /></button></div>
          <dl className="config-list"><div><dt>Agent</dt><dd>{run.model}<small>{run.modelVersion}</small></dd></div><div><dt>Scenario</dt><dd>{run.dataset}<small>deterministic simulated payment</small></dd></div><div><dt>Evidence</dt><dd>ledger + trace<small>independent evaluator</small></dd></div><div><dt>Execution</dt><dd><span className="environment-dot" /> Local safe mode<small>untrusted code disabled</small></dd></div></dl>
        </section>
      </div>
      <section className="evidence-panel">
        <div className="evidence-mark"><Icon name="shield" size={18} /></div>
         <div><span className="section-kicker">Evidence preview</span><h2>Every result should be explainable.</h2><p>Trace-level events, ledger entries, failed invariants, and grounded recommendations are derived from the deterministic engine.</p></div>
        <button className="text-button" type="button">Learn about traces <Icon name="external-link" size={14} /></button>
      </section>
    </>
  )
}

function EvaluatorRow({ evaluator }: { evaluator: EvaluatorResult }) {
  return (
    <div className="evaluator-row">
      <span className={`evaluator-icon ${evaluator.status === 'passed' ? 'evaluator-pass' : 'evaluator-attention'}`}><Icon name={evaluator.status === 'passed' ? 'check' : 'warning'} size={15} /></span>
      <span className="evaluator-copy"><strong>{evaluator.name}</strong><span>{evaluator.description}</span></span>
      <span className="evaluator-score"><strong>{evaluator.score}%</strong><small>{evaluator.passed}/{evaluator.total}</small></span>
      <Icon name="chevron-right" size={16} className="row-chevron" />
    </div>
  )
}

function App() {
  return <BrowserRouter><Workspace /></BrowserRouter>
}

export default App
