import { useMemo, useState } from 'react'
import { demoCoverage, demoEvaluators, demoRuns, demoTrend } from './data/demo'
import { Icon, type IconName } from './components/Icon'
import type { CoverageItem, EvaluatorResult, Run, View } from './types'

const navItems: Array<{ id: View; label: string; icon: IconName }> = [
  { id: 'overview', label: 'Overview', icon: 'layers' },
  { id: 'dashboard', label: 'Evaluation runs', icon: 'activity' },
]

const viewLabels: Record<View, string> = {
  overview: 'Overview',
  dashboard: 'Evaluation runs',
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

function DemoPill() {
  return (
    <span className="demo-pill">
      <span className="demo-pulse" />
      Demo environment
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

function App() {
  const [view, setView] = useState<View>('overview')
  const [selectedRunId, setSelectedRunId] = useState(demoRuns[0].id)
  const selectedRun = useMemo(
    () => demoRuns.find((run) => run.id === selectedRunId) ?? demoRuns[0],
    [selectedRunId],
  )

  const openRun = (runId: string) => {
    setSelectedRunId(runId)
    setView('run')
  }

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
            <strong>verity-labs</strong>
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
            <span className="usage-footnote">3,840 of 12,000 cases</span>
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
            <DemoPill />
            <button aria-label="Search" className="search-button" type="button">
              <Icon name="search" size={16} />
              <span>Search</span>
              <kbd>⌘ K</kbd>
            </button>
            <button aria-label="Open notifications" className="icon-button notification-button" type="button">
              <Icon name="activity" size={18} />
              <span className="notification-dot" />
            </button>
            <span aria-label="Alex V. profile" className="topbar-avatar">AV</span>
          </div>
        </header>

        <main className="page-content">
          <div className="demo-banner">
            <Icon name="sparkles" size={16} />
            <span><strong>Demo data</strong> · This workspace uses local fixtures until an API is connected.</span>
            <button aria-label="Dismiss demo data notice" className="banner-dismiss" type="button">×</button>
          </div>

          {view === 'overview' && <Overview onNavigate={setView} onOpenRun={openRun} />}
          {view === 'dashboard' && <Dashboard onOpenRun={openRun} />}
          {view === 'run' && <RunDetail run={selectedRun} onBack={() => setView('dashboard')} />}
        </main>
      </div>
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
          <span className="eyebrow"><Icon name="sparkles" size={14} /> Model reliability workspace</span>
          <h1>Measure what your models <span>actually know.</span></h1>
          <p>Turn evaluation signals into confident releases. VerityBench brings your model, dataset, and evidence into one calm workspace.</p>
          <div className="hero-actions">
            <button className="button button-primary" onClick={() => onNavigate('dashboard')} type="button">
              Explore runs <Icon name="arrow-right" size={16} />
            </button>
            <button className="button button-secondary" onClick={() => onOpenRun(demoRuns[0].id)} type="button">
              <Icon name="play" size={14} /> Open latest run
            </button>
          </div>
          <div className="hero-meta">
            <span><Icon name="check" size={14} /> 3,840 cases evaluated</span>
            <span><Icon name="shield" size={14} /> Release-ready signals</span>
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
        <MetricCard label="Average score" value="86.4%" change="+4.8%" detail="vs. previous 7 days" icon="gauge" tone="cyan" />
        <MetricCard label="Cases evaluated" value="3,840" change="+18.2%" detail="across 12 runs" icon="layers" tone="violet" />
        <MetricCard label="Release confidence" value="94%" change="+2.1%" detail="above your 90% target" icon="shield" tone="green" />
      </div>

      <div className="overview-columns">
        <RecentRuns onOpenRun={onOpenRun} />
        <CoveragePanel />
      </div>

      <section className="insight-strip">
        <div className="insight-icon"><Icon name="trend-up" size={19} /></div>
        <div>
          <span className="section-kicker">Demo insight</span>
          <h3>Safety improved 6.2% after the latest prompt revision.</h3>
          <p>Compare run-042 against the prior baseline to inspect the evidence behind the lift.</p>
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
        <span className="card-label"><span className="live-dot" /> Evaluation pulse</span>
        <button aria-label="Pulse card options" className="icon-button subtle-icon" type="button"><Icon name="more" size={18} /></button>
      </div>
      <div className="pulse-score">92.8<span>%</span></div>
      <div className="pulse-score-label">Latest release gate score</div>
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
      <div className="pulse-footer"><span><Icon name="trend-up" size={14} /> 4.8% lift</span><span>Last 7 days</span></div>
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
      <div className="coverage-note"><Icon name="shield" size={15} /> <span>All signals are from the local demo dataset.</span></div>
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
      <PageIntro eyebrow="Evaluation workspace" title="Evaluation runs" description="A clear view of how your models behave across the checks that matter." action={<button className="button button-primary" type="button"><Icon name="play" size={14} /> New evaluation</button>} />
      <div className="metric-grid dashboard-metrics">
        <MetricCard label="Average score" value="86.4%" change="+4.8%" detail="vs. previous 7 days" icon="gauge" tone="cyan" />
        <MetricCard label="Total evaluations" value="12" change="+3" detail="this week" icon="activity" tone="violet" />
        <MetricCard label="Passing cases" value="3,262" change="85.0%" detail="of 3,840 evaluated" icon="check" tone="green" />
        <MetricCard label="Needs attention" value="02" change="-1" detail="since last baseline" icon="warning" tone="amber" />
      </div>
      <div className="dashboard-grid">
        <TrendPanel />
        <ModelPanel />
      </div>
      <section className="panel runs-table-panel">
        <div className="panel-heading table-heading">
          <div><span className="section-kicker">Local demo dataset</span><h2>All evaluation runs</h2></div>
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
      <div className="trend-summary"><strong>86.4%</strong><span className="positive"><Icon name="trend-up" size={14} /> 4.8% from last week</span></div>
      <div className="trend-chart">
        <div className="chart-y-labels"><span>100</span><span>90</span><span>80</span><span>70</span></div>
        <svg preserveAspectRatio="none" viewBox="0 0 100 104" aria-label="Seven day evaluation score trend" role="img"><defs><linearGradient id="trend-gradient" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#7a8cff" stopOpacity=".22" /><stop offset="100%" stopColor="#7a8cff" stopOpacity="0" /></linearGradient></defs><path d={`M ${areaPoints}`} fill="url(#trend-gradient)" /><polyline fill="none" points={points} stroke="#8b9aff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4" /><circle cx="100" cy="45" fill="#0d1119" r="2.7" stroke="#8b9aff" strokeWidth="1.4" /></svg>
      </div>
      <div className="chart-x-labels">{demoTrend.map((point) => <span key={point.label}>{point.label}</span>)}</div>
    </section>
  )
}

function ModelPanel() {
  const models = [{ name: 'Atlas 3.1', score: 92.8, cases: '1,200', color: 'cyan' }, { name: 'Atlas 3.0', score: 86.4, cases: '1,920', color: 'violet' }, { name: 'Nimbus 2.8', score: 74.6, cases: '720', color: 'amber' }]
  return (
    <section className="panel model-panel">
      <div className="panel-heading"><div><span className="section-kicker">Model comparison</span><h2>By model</h2></div><button aria-label="Model comparison options" className="icon-button subtle-icon" type="button"><Icon name="more" size={17} /></button></div>
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
          <div className="panel-heading"><div><span className="section-kicker">Evaluation signals</span><h2>Evaluator breakdown</h2></div><span className="muted-label">4 evaluators</span></div>
          <div className="evaluator-list">{demoEvaluators.map((evaluator) => <EvaluatorRow evaluator={evaluator} key={evaluator.name} />)}</div>
        </section>
        <section className="panel config-panel">
          <div className="panel-heading"><div><span className="section-kicker">Run context</span><h2>Configuration</h2></div><button aria-label="Configuration options" className="icon-button subtle-icon" type="button"><Icon name="more" size={17} /></button></div>
          <dl className="config-list"><div><dt>Model</dt><dd>{run.model}<small>{run.modelVersion}</small></dd></div><div><dt>Dataset</dt><dd>{run.dataset}<small>v4 · 480 records</small></dd></div><div><dt>Evaluator set</dt><dd>verity-standard<small>4 active evaluators</small></dd></div><div><dt>Environment</dt><dd><span className="environment-dot" /> Local demo<small>API not connected</small></dd></div></dl>
        </section>
      </div>
      <section className="evidence-panel">
        <div className="evidence-mark"><Icon name="shield" size={18} /></div>
        <div><span className="section-kicker">Evidence preview</span><h2>Every score should be explainable.</h2><p>Trace-level evidence will appear here when the evaluation API is connected. The demo shell keeps this state explicit rather than fabricating model output.</p></div>
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

export default App
