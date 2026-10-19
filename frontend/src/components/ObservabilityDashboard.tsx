import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from './Icon'
import type { ApiRun } from '../lib/api'
import type { CoverageItem, Run, View } from '../types'

type Stats = { passRate: string; evaluated: string; traceCount: string; duplicateCharges: string; safeRetests: string }
type Props = {
  apiData: boolean
  apiRuns: ApiRun[]
  coverage: CoverageItem[]
  runs: Run[]
  stats: Stats
  overview?: boolean
  compactRows?: boolean
  composer?: ReactNode
  onNavigate?: (view: View) => void
  onOpenRun: (id: string) => void
  onRun: () => void
}

const isPassed = (run: Run) => run.status === 'passed' || run.status === 'completed'
const needsReview = (run: Run) => ['failed', 'needs-review', 'timed_out', 'inconclusive'].includes(run.status)
const stateLabel = (run: Run) => run.status === 'completed' ? 'Passed' : run.status === 'needs-review' ? 'Needs review' : run.status.replaceAll('_', ' ')
const score = (value: number | null) => value === null ? '—' : `${value}%`

function traceCount(run: Run, apiRuns: ApiRun[]): number | null {
  const persisted = apiRuns.find((item) => item.id === run.id)
  if (persisted) return persisted.report?.trace.length ?? null
  const fixture = /^(\d+) events$/.exec(run.duration)
  return fixture ? Number(fixture[1]) : null
}

export function ObservabilityDashboard({ apiData, apiRuns, coverage, runs, stats, overview = false, compactRows = false, composer, onNavigate, onOpenRun, onRun }: Props) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [state, setState] = useState('all')
  const [sort, setSort] = useState<'recent' | 'score' | 'name'>('recent')
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(10)
  const [comparing, setComparing] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || target?.isContentEditable || target?.closest('input, textarea, select, [role="dialog"]')) return
      event.preventDefault()
      searchInput.current?.focus()
    }
    window.addEventListener('keydown', focusSearch)
    return () => window.removeEventListener('keydown', focusSearch)
  }, [])
  const reports = apiRuns.flatMap((run) => run.report ? [run.report] : [])
  const checks = runs.reduce((sum, run) => sum + run.cases, 0)
  const passedChecks = runs.reduce((sum, run) => sum + run.passedCases, 0)
  const findings = apiData ? reports.reduce((sum, report) => sum + report.evaluation.findings.length, 0) : null
  const filtered = useMemo(() => {
    const values = runs.filter((run) => {
      const matchesGroup = filter === 'all' || (filter === 'passed' ? isPassed(run) : filter === 'review' ? needsReview(run) : ['running', 'queued', 'cancel_requested'].includes(run.status))
      return matchesGroup && (state === 'all' || run.status === state) && `${run.name} ${run.model} ${run.dataset} ${run.id}`.toLowerCase().includes(query.trim().toLowerCase())
    })
    if (sort === 'name') values.sort((a, b) => a.name.localeCompare(b.name))
    if (sort === 'score') values.sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    return values
  }, [runs, query, filter, state, sort])
  useEffect(() => setPage(0), [query, filter, state, sort, pageSize])
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const activePage = Math.min(page, pages - 1)
  const visibleRuns = filtered.slice(activePage * pageSize, (activePage + 1) * pageSize)

  return <div className="observability-dashboard">
    <div className="page-intro workspace-intro">
      <div><span className="eyebrow"><Icon name="activity" size={13} /> Agent reliability workspace</span><h1>{overview ? 'Overview' : 'Agent runs'}<span aria-hidden="true" className="workspace-environment">{apiData ? 'PROJECT' : 'EXPLORER'}</span></h1><p>{overview ? 'Every outcome, backed by evidence.' : 'Evaluate, compare, and inspect your agent experiments.'}</p></div>
      <div className="workspace-page-actions"><span className="history-scope"><Icon name="clock" size={13} /> Loaded history</span><button className="button button-primary" onClick={onRun} type="button"><Icon name="play" size={13} /> New evaluation</button></div>
    </div>
    <div className="workspace-view-tabs" aria-label="Workspace views">
      <button aria-current={overview ? 'page' : undefined} className={overview ? 'is-current' : ''} onClick={() => onNavigate?.('overview')} type="button">Overview</button>
      <button aria-current={!overview ? 'page' : undefined} className={!overview ? 'is-current' : ''} onClick={() => onNavigate?.('dashboard')} type="button">Experiments <span>{runs.length}</span></button>
      <button onClick={() => onNavigate?.('evaluators')} type="button">Evaluators <Icon name="arrow-up-right" size={12} /></button>
      <span className="workspace-source-note"><span className={apiData ? 'signal-dot' : 'signal-dot fixture-dot'} />{apiData ? 'Persisted project reports' : 'Read-only local fixtures'}</span>
    </div>
    {composer}
    <section aria-label="Evaluation summary" className="workspace-stat-grid">
      <Stat label="Evaluation pass rate" value={stats.passRate} detail={stats.evaluated} tone="green" />
      <Stat label="Experiments" value={String(runs.length)} detail={`${runs.filter(isPassed).length} passed · ${runs.filter(needsReview).length} need review`} tone="violet" />
      <Stat label="Checks passing" value={checks ? `${passedChecks}/${checks}` : '—'} detail={apiData ? 'From evaluation invariants' : 'Fixture case results'} />
      <Stat label="Recorded events" value={stats.traceCount} detail={apiData ? `${findings ?? 0} findings in loaded reports` : 'From the local fixture set'} />
    </section>
    {overview ? <div className="workspace-overview-charts">
      <HistoryChart apiRuns={apiRuns} kind="score" onOpenRun={onOpenRun} runs={runs} />
      <CoverageCard apiData={apiData} items={coverage} />
    </div> : <div className="workspace-chart-grid">
      <HistoryChart apiRuns={apiRuns} kind="score" onOpenRun={onOpenRun} runs={runs} />
      <HistoryChart apiRuns={apiRuns} kind="checks" onOpenRun={onOpenRun} runs={runs} />
      <HistoryChart apiRuns={apiRuns} kind="events" onOpenRun={onOpenRun} runs={runs} />
    </div>}
    <section aria-label="Experiment results" className="panel experiment-results">
      <div className="experiment-heading"><div><h2>{apiData ? 'Experiment results' : 'Fixture run history'}</h2><span>{apiData ? 'Reports from your selected project' : 'Repository-owned examples · not production telemetry'}</span></div><button aria-expanded={comparing} className="button button-quiet" disabled={runs.length < 2} onClick={() => setComparing((current) => !current)} type="button"><Icon name="layers" size={13} />{comparing ? 'Close comparison' : 'Compare runs'}</button></div>
      {comparing && <Comparison runs={runs} />}
      <div className="table-toolbar workspace-table-toolbar">
        <label className="search-field"><Icon name="search" size={14} /><span className="sr-only">Filter runs</span><input onChange={(event) => setQuery(event.target.value)} placeholder="Search experiments…" ref={searchInput} value={query} /><kbd>/</kbd></label>
        <div aria-label="Run status filter" className="filter-group">
          {([['all', 'All'], ['passed', 'Passed'], ['review', 'Needs review'], ['active', 'Active']] as const).map(([value, label]) => <button aria-pressed={filter === value} className={filter === value ? 'filter-active' : ''} key={value} onClick={() => setFilter(value)} type="button">{label}</button>)}
        </div>
        <label className="workspace-select"><Icon name="sliders" size={13} /><span className="sr-only">Execution state</span><select onChange={(event) => setState(event.target.value)} value={state}><option value="all">All states</option>{Array.from(new Set(runs.map((run) => run.status))).map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></label>
      </div>
      <div className="experiment-table-scroll" tabIndex={0} role="region" aria-label="Scrollable experiment table">
        <table className={`experiment-table ${compactRows ? 'is-compact' : ''}`}>
          <thead><tr><th aria-sort={sort === 'name' ? 'ascending' : 'none'}><button onClick={() => setSort(sort === 'name' ? 'recent' : 'name')} type="button">Experiment <span>↕</span></button></th><th>Agent</th><th>Status</th><th>Checks</th><th aria-sort={sort === 'score' ? 'descending' : 'none'}><button onClick={() => setSort(sort === 'score' ? 'recent' : 'score')} type="button">Score <span>↕</span></button></th><th>Evidence</th><th>Recorded</th><th><span className="sr-only">Open run</span></th></tr></thead>
          <tbody>{visibleRuns.length ? visibleRuns.map((run) => <tr key={run.id} onClick={() => onOpenRun(run.id)}>
            <td><button aria-label={run.name} className="experiment-name" onClick={(event) => { event.stopPropagation(); onOpenRun(run.id) }} type="button"><span className="experiment-id">{run.id.length > 12 ? run.id.slice(0, 8) : run.id.replace('run-', '#')}</span><span><strong>{run.name}</strong><small>{run.dataset}</small></span></button></td>
            <td><span className={`agent-table-dot ${run.model.includes('defective') ? 'is-defective' : ''}`} />{run.model}</td>
            <td><RunState run={run} /></td>
            <td><div className="experiment-checks"><span>{run.passedCases}<span> / {run.cases}</span></span><span className="check-ratio" title={`${run.passedCases} of ${run.cases} checks passed`}><span style={{ width: `${run.cases ? run.passedCases / run.cases * 100 : 0}%` }} /></span></div></td>
            <td><strong className={isPassed(run) ? 'positive mono-score' : needsReview(run) ? 'negative mono-score' : 'mono-score'}>{score(run.score)}</strong></td>
            <td className="experiment-mono">{traceCount(run, apiRuns) === null ? run.duration : `${traceCount(run, apiRuns)} events`}</td>
            <td className="experiment-date">{run.completedAt}</td>
            <td><Icon name="chevron-right" size={13} /></td>
          </tr>) : <tr><td className="experiment-empty" colSpan={8}><Icon name="search" size={20} /><strong>{runs.length ? 'No runs match your filters.' : apiData ? 'No persisted experiments yet.' : 'No local fixtures available.'}</strong><span>{runs.length ? 'Try another search or state.' : 'Start an evaluation to record your first result.'}</span></td></tr>}</tbody>
        </table>
      </div>
      <div className="experiment-pagination"><span>{filtered.length ? `${activePage * pageSize + 1}–${Math.min((activePage + 1) * pageSize, filtered.length)} of ${filtered.length} experiments` : '0 experiments'}<span className="pagination-boundary"> · {apiData ? 'Loaded project history' : 'Local fixtures'}</span></span><div><label><span className="sr-only">Rows per page</span><select onChange={(event) => setPageSize(Number(event.target.value))} value={pageSize}><option value={10}>Show 10</option><option value={25}>Show 25</option><option value={50}>Show 50</option></select></label><span>Page {activePage + 1}</span><button aria-label="Previous page" disabled={activePage === 0} onClick={() => setPage(activePage - 1)} type="button"><Icon name="arrow-left" size={13} /></button><button aria-label="Next page" disabled={activePage >= pages - 1} onClick={() => setPage(activePage + 1)} type="button"><Icon name="arrow-right" size={13} /></button></div></div>
    </section>
    <div className="workspace-bottom-note"><Icon name="shield" size={13} /><span>Test agents. Trust the evidence. <span>Scores reflect recorded checks, not agent claims.</span></span><button onClick={() => onNavigate?.('cli')} type="button">CLI & API guide <Icon name="arrow-up-right" size={12} /></button></div>
  </div>
}

function Stat({ label, value, detail, tone = '' }: { label: string; value: string; detail: string; tone?: string }) {
  return <article className={`workspace-stat stat-${tone}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>
}

function RunState({ run }: { run: Run }) {
  return <span className={`result-status ${isPassed(run) ? 'result-passed' : needsReview(run) ? 'result-failed' : 'result-pending'}`}><Icon name={isPassed(run) ? 'check' : needsReview(run) ? 'warning' : 'clock'} size={11} />{stateLabel(run)}</span>
}

function HistoryChart({ apiRuns, kind, onOpenRun, runs }: { apiRuns: ApiRun[]; kind: 'score' | 'checks' | 'events'; onOpenRun: (id: string) => void; runs: Run[] }) {
  const latest = runs.slice(0, 8).reverse()
  const data = latest.map((run) => ({
    run,
    value: kind === 'score' ? run.score : kind === 'checks' ? run.cases : traceCount(run, apiRuns),
  }))
  const available = data.filter((item) => item.value !== null)
  const largest = Math.max(0, ...available.map((item) => item.value ?? 0))
  const max = kind === 'score' ? 100 : Math.max(4, Math.ceil(largest / 4) * 4)
  const titles = { score: 'Evaluation scores', checks: 'Check outcomes', events: 'Trace evidence' }
  const hints = { score: 'Independent check pass rate', checks: 'Recorded checks per experiment', events: 'Recorded events per experiment' }
  return <section aria-label={titles[kind]} className={`panel history-chart chart-${kind}`}>
    <div className="chart-card-heading"><h2>{titles[kind]}</h2><span className="chart-unit">{kind === 'score' ? '0–100%' : kind === 'checks' ? 'Checks' : 'Events'}</span></div>
    <div className="chart-card-legend"><span><i className={kind === 'events' ? 'chart-dot-blue' : ''} />{kind === 'score' ? 'Passed score' : kind === 'checks' ? 'Passed' : 'Trace events'}</span>{kind === 'score' && <span><i className="chart-dot-violet" />Other score</span>}{kind === 'checks' && <span><i className="chart-dot-red" />Failed</span>}<small>Latest {available.length} recorded</small></div>
    {available.length ? <div aria-label={hints[kind]} className="history-chart-area">
      <div className="history-chart-y">{[1, .75, .5, .25, 0].map((fraction) => <span key={fraction}>{kind === 'score' ? `${fraction * 100}%` : Number((max * fraction).toFixed(1))}</span>)}</div>
      <div className="history-chart-plot"><div className="history-grid-lines" aria-hidden="true">{[0, 1, 2, 3, 4].map((line) => <i key={line} />)}</div>
        <div className="history-chart-bars">{data.map(({ run, value }) => <button aria-label={`Open ${run.name}: ${value === null ? 'not recorded' : `${value}${kind === 'score' ? '%' : ` ${kind}`}`}`} className="history-chart-column" key={run.id} onClick={() => onOpenRun(run.id)} title={`${run.name}\n${value ?? 'Not recorded'} ${kind === 'score' ? '%' : kind}`} type="button">
          <span className="history-bar-space">{value !== null ? <span className={`history-bar ${kind === 'events' ? 'bar-blue' : kind === 'score' && !isPassed(run) ? 'bar-violet' : 'bar-mint'}`} style={{ height: `${value / max * 100}%` }}>{kind === 'checks' && <><span className="history-check-fail" style={{ height: `${run.cases ? (run.cases - run.passedCases) / run.cases * 100 : 0}%` }} /><span className="history-check-pass" style={{ height: `${run.cases ? run.passedCases / run.cases * 100 : 0}%` }} /></>}</span> : <span className="history-bar-unavailable">—</span>}<span className="history-bar-tooltip">{value ?? '—'}{kind === 'score' && value !== null ? '%' : ''}</span></span>
          <span className="history-bar-label">{run.id.startsWith('run-') ? `#${run.id.slice(4)}` : run.id.slice(0, 6)}</span>
        </button>)}</div>
      </div>
    </div> : <div className="chart-empty"><Icon name="activity" size={22} /><span>No recorded {kind === 'score' ? 'scores' : kind} yet</span><small>New evaluation results will appear here.</small></div>}
    <p className="chart-provenance">{hints[kind]} · click a bar to inspect</p>
  </section>
}

function CoverageCard({ apiData, items }: { apiData: boolean; items: CoverageItem[] }) {
  return <section className="panel workspace-coverage"><div className="chart-card-heading"><h2>Evaluator breakdown</h2><span className="chart-unit">{items.length} signals</span></div><p className="coverage-source">{apiData ? 'Invariant pass rates across loaded reports' : 'Repository fixture snapshot'}</p><div className="workspace-coverage-list">{items.length ? items.map((item) => <div className="workspace-coverage-item" key={item.label}><div><span>{item.label}</span><strong>{item.value}%</strong></div><div aria-label={`${item.label}: ${item.value} percent`} aria-valuemax={100} aria-valuemin={0} aria-valuenow={item.value} className="workspace-coverage-track" role="progressbar"><span style={{ width: `${item.value}%` }} /></div></div>) : <div className="chart-empty"><Icon name="shield" size={22} /><span>No checks recorded yet.</span></div>}</div></section>
}

function Comparison({ runs }: { runs: Run[] }) {
  const [leftId, setLeftId] = useState(runs[0]?.id ?? '')
  const [rightId, setRightId] = useState(runs[1]?.id ?? '')
  const left = runs.find((run) => run.id === leftId) ?? runs[0]
  const right = runs.find((run) => run.id === rightId) ?? runs[1]
  return <section className="workspace-comparison" aria-label="Compare loaded runs">
    <div className="comparison-selectors"><label>Run A<select onChange={(event) => setLeftId(event.target.value)} value={left?.id ?? ''}>{runs.map((run) => <option key={run.id} value={run.id}>{run.name} · {run.id}</option>)}</select></label><span className="comparison-vs">vs</span><label>Run B<select onChange={(event) => setRightId(event.target.value)} value={right?.id ?? ''}>{runs.map((run) => <option key={run.id} value={run.id}>{run.name} · {run.id}</option>)}</select></label></div>
    {left && right && <div className="workspace-comparison-facts">{[
      ['Status', stateLabel(left), stateLabel(right)],
      ['Check score', score(left.score), score(right.score)],
      ['Checks passed', `${left.passedCases} / ${left.cases}`, `${right.passedCases} / ${right.cases}`],
      ['Timing / evidence', left.duration, right.duration],
    ].map(([label, a, b]) => <div key={label}><span>{label}</span><strong>{a}</strong><strong>{b}</strong></div>)}</div>}
  </section>
}
