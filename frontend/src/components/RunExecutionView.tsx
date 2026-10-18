import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import type { ApiClient, ApiEvaluation, ApiReport, ApiRun, ApiRunEvent } from '../lib/api'

type ExecutionState = 'queued' | 'running' | 'cancelled' | 'passed' | 'failed'
type EventFilter = 'all' | 'lifecycle' | 'agent' | 'payment' | 'order'

const terminalStates = new Set<ExecutionState>(['cancelled', 'passed', 'failed'])

function normalizeState(state: string): ExecutionState {
  if (state === 'queued' || state === 'running' || state === 'cancelled' || state === 'passed') return state
  return 'failed'
}

function isTerminal(state: string) {
  return terminalStates.has(normalizeState(state))
}

function formatScenario(value: string) {
  return value.replaceAll('_', ' ')
}

function formatDate(value: string | null) {
  if (!value) return 'Not completed'
  const date = new Date(value)
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function formatEventName(value: string) {
  return value.replaceAll('_', ' ')
}

function eventCategory(value: string): Exclude<EventFilter, 'all'> {
  if (value.startsWith('run_')) return 'lifecycle'
  if (value.startsWith('agent_')) return 'agent'
  if (value.startsWith('payment_')) return 'payment'
  return 'order'
}

function eventTone(value: string) {
  if (value.startsWith('run_')) return 'event-lifecycle'
  if (value.startsWith('agent_')) return 'event-agent'
  if (value.includes('failed') || value.includes('cancel')) return 'event-failed'
  return 'event-neutral'
}

type RunExecutionViewProps = {
  api: ApiClient
  initialRun: ApiRun
  onBack: () => void
  onRunUpdated?: (run: ApiRun) => void
  token: string
}

export function RunExecutionView({ api, initialRun, onBack, onRunUpdated, token }: RunExecutionViewProps) {
  const [run, setRun] = useState<ApiRun>(initialRun)
  const [events, setEvents] = useState<ApiRunEvent[]>([])
  const [selectedSequence, setSelectedSequence] = useState<number | null>(null)
  const [filter, setFilter] = useState<EventFilter>('all')
  const [query, setQuery] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [cancelBusy, setCancelBusy] = useState(false)
  const [error, setError] = useState('')
  const [transport, setTransport] = useState<'history' | 'stream' | 'polling'>('history')
  const [reloadNonce, setReloadNonce] = useState(0)
  const timelineRef = useRef<HTMLDivElement>(null)
  const onRunUpdatedRef = useRef(onRunUpdated)

  useEffect(() => {
    setRun(initialRun)
  }, [initialRun])

  useEffect(() => {
    onRunUpdatedRef.current = onRunUpdated
  }, [onRunUpdated])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    let latestSequence = -1
    let currentState = normalizeState(initialRun.state)

    const publishRun = (nextRun: ApiRun) => {
      if (!active) return
      currentState = normalizeState(nextRun.state)
      setRun(nextRun)
      onRunUpdatedRef.current?.(nextRun)
    }

    const ingestEvent = (event: ApiRunEvent) => {
      if (!active || event.run_id !== initialRun.id || event.sequence <= latestSequence) return
      latestSequence = event.sequence
      setEvents((current) => current.some((item) => item.sequence === event.sequence) ? current : [...current, event].sort((a, b) => a.sequence - b.sequence))
      const eventState = event.payload.state
      if (typeof eventState === 'string') currentState = normalizeState(eventState)
    }

    const wait = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds))

    const pollUntilTerminal = async () => {
      setTransport('polling')
      while (active && !isTerminal(currentState)) {
        await wait(900)
        if (!active) return
        const [nextRun, nextEvents] = await Promise.all([
          api.getApiRun(token, initialRun.id),
          api.pollRunEvents(token, initialRun.id, latestSequence),
        ])
        publishRun(nextRun)
        nextEvents.forEach(ingestEvent)
      }
    }

    const loadAndSubscribe = async () => {
      setLoading(true)
      setError('')
      setTransport('history')
      try {
        const [nextRun, history] = await Promise.all([
          api.getApiRun(token, initialRun.id),
          api.listRunEvents(token, initialRun.id, -1),
        ])
        if (!active) return
        publishRun(nextRun)
        history.forEach(ingestEvent)
        setLoading(false)
        if (isTerminal(nextRun.state)) return

        setTransport('stream')
        try {
          await api.streamRunEvents(token, initialRun.id, latestSequence, ingestEvent, controller.signal)
          if (active && !isTerminal(currentState)) await pollUntilTerminal()
        } catch (streamError: unknown) {
          if (!active || controller.signal.aborted) return
          setError(streamError instanceof Error ? `${streamError.message}. Falling back to polling.` : 'Live event stream unavailable. Falling back to polling.')
          await pollUntilTerminal()
        }

        if (active) {
          const completedRun = await api.getApiRun(token, initialRun.id)
          publishRun(completedRun)
        }
      } catch (requestError: unknown) {
        if (active && !controller.signal.aborted) {
          setError(requestError instanceof Error ? requestError.message : 'Could not load run history.')
          setLoading(false)
        }
      }
    }

    void loadAndSubscribe()
    return () => {
      active = false
      controller.abort()
    }
  }, [api, initialRun.id, reloadNonce, token])

  const executionState = normalizeState(run.state)
  const filteredEvents = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return events.filter((event) => {
      const matchesFilter = filter === 'all' || eventCategory(event.event_type) === filter
      const matchesQuery = !normalizedQuery || `${event.event_type} ${event.sequence} ${JSON.stringify(event.payload)}`.toLowerCase().includes(normalizedQuery)
      return matchesFilter && matchesQuery
    })
  }, [events, filter, query])
  const selectedEvent = events.find((event) => event.sequence === selectedSequence) ?? filteredEvents[filteredEvents.length - 1] ?? events[events.length - 1] ?? null
  const latestEvent = events[events.length - 1] ?? null

  useEffect(() => {
    if (selectedSequence !== null && events.some((event) => event.sequence === selectedSequence)) return
    setSelectedSequence(events[events.length - 1]?.sequence ?? null)
  }, [events, selectedSequence])

  useEffect(() => {
    if (autoScroll && timelineRef.current) timelineRef.current.scrollTop = timelineRef.current.scrollHeight
  }, [autoScroll, filteredEvents.length])

  const refresh = () => {
    setRefreshing(true)
    setReloadNonce((current) => current + 1)
    window.setTimeout(() => setRefreshing(false), 450)
  }

  const cancel = async () => {
    setCancelBusy(true)
    setError('')
    try {
      const nextRun = await api.cancelRun(token, run.id)
      setRun(nextRun)
      onRunUpdated?.(nextRun)
      setReloadNonce((current) => current + 1)
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : 'Could not request cancellation.')
    } finally {
      setCancelBusy(false)
    }
  }

  const cancelDisabled = cancelBusy || run.cancel_requested || isTerminal(run.state)
  return (
    <>
      <button className="back-button" onClick={onBack} type="button"><Icon name="arrow-left" size={16} /> Back to runs</button>
      <div className="run-detail-header execution-header">
        <div>
          <div className="run-id-line"><span className="run-id-badge">{run.id}</span><ExecutionBadge state={executionState} /></div>
          <h1>Active execution</h1>
          <p>{run.agent} <span>·</span> {formatScenario(run.scenario)} <span>·</span> started {formatDate(run.started_at ?? run.created_at)}</p>
        </div>
        <div className="run-detail-actions">
          <span className={`transport-pill transport-${transport}`}><span />{transport === 'stream' ? 'Live stream' : transport === 'polling' ? 'Polling fallback' : 'History loaded'}</span>
          <button className="button button-quiet" disabled={refreshing} onClick={refresh} type="button"><Icon name="refresh" size={15} /> Refresh history</button>
          {!isTerminal(run.state) && <button className="button button-danger" disabled={cancelDisabled} onClick={() => void cancel()} type="button">{cancelBusy ? 'Cancelling…' : 'Cancel run'}</button>}
        </div>
      </div>

      {error && <div className="inline-error execution-error" role="alert">{error}</div>}
      <section aria-label="Execution status" className="execution-status-grid">
        <div className={`execution-state-card execution-state-${executionState}`}><span className="section-kicker">Execution state</span><strong>{executionState}</strong><span>{run.cancel_requested && !isTerminal(run.state) ? 'Cancellation requested' : stateDescription(executionState)}</span></div>
        <div className="execution-context-card"><span className="section-kicker">Scenario</span><strong>{formatScenario(run.scenario)}</strong><span>{latestEvent ? `Latest: ${formatEventName(latestEvent.event_type)}` : 'Waiting for the first persisted event'}</span></div>
        <div className="execution-context-card"><span className="section-kicker">Observed history</span><strong>{events.length} events</strong><span>{run.completed_at ? `Finished ${formatDate(run.completed_at)}` : 'Durable events received so far'}</span></div>
      </section>

      <section className="panel execution-progress-panel">
        <div className="panel-heading"><div><span className="section-kicker">Scenario progress</span><h2>{latestEvent ? formatEventName(latestEvent.event_type) : 'Waiting for worker'}</h2></div><span className="muted-label">{events.length} persisted events · no estimated steps</span></div>
        <div aria-label={`${events.length} persisted events observed; execution is ${executionState}`} aria-valuetext={`${events.length} persisted events observed; execution is ${executionState}`} className={`execution-progress-track ${isTerminal(executionState) ? 'execution-progress-complete' : 'execution-progress-live'}`} role="progressbar"><span /></div>
        <p className="execution-progress-note">Progress reflects lifecycle and engine events returned by the API. The web client does not invent intermediate steps or percentages.</p>
      </section>

      <div className="execution-layout">
        <section className="panel execution-timeline-panel">
          <div className="panel-heading"><div><span className="section-kicker">Durable event log</span><h2>Execution timeline</h2></div><span className="muted-label">{filteredEvents.length} shown · {events.length} total</span></div>
          <div className="table-toolbar execution-toolbar">
            <label className="search-field"><Icon name="search" size={15} /><span className="sr-only">Search events</span><input onChange={(event) => setQuery(event.target.value)} placeholder="Search event type or payload" value={query} /></label>
            <label className="event-filter"><span className="sr-only">Filter event category</span><select onChange={(event) => setFilter(event.target.value as EventFilter)} value={filter}><option value="all">All events</option><option value="lifecycle">Lifecycle</option><option value="agent">Agent</option><option value="payment">Payment</option><option value="order">Order and ledger</option></select></label>
            <button aria-pressed={autoScroll} className={`button button-quiet auto-scroll-button ${autoScroll ? 'is-active' : ''}`} onClick={() => setAutoScroll((current) => !current)} type="button"><Icon name={autoScroll ? 'activity' : 'clock'} size={14} /> {autoScroll ? 'Auto-scroll on' : 'Auto-scroll paused'}</button>
          </div>
          <div aria-label="Run event timeline" className="execution-timeline" ref={timelineRef} role="log">
            {loading ? <div className="empty-panel" role="status">Loading persisted events…</div> : filteredEvents.length ? filteredEvents.map((event) => <EventRow event={event} key={event.sequence} onSelect={() => setSelectedSequence(event.sequence)} selected={selectedEvent?.sequence === event.sequence} />) : <EmptyTimeline hasEvents={events.length > 0} />}
          </div>
        </section>

        <EventDetails event={selectedEvent} />
      </div>

      {run.report && <PersistedReportSummary report={run.report} run={run} />}
      {run.report && <ApiReportEvidence report={run.report} />}
    </>
  )
}

function ExecutionBadge({ state }: { state: ExecutionState }) {
  return <span className={`execution-badge execution-badge-${state}`}><span className="status-dot" />{state}</span>
}

function stateDescription(state: ExecutionState) {
  if (state === 'queued') return 'Waiting for an execution worker'
  if (state === 'running') return 'Worker is emitting durable events'
  if (state === 'cancelled') return 'Execution stopped before completion'
  if (state === 'passed') return 'All persisted evaluation invariants passed'
  return 'Execution completed with a failure state'
}

function EventRow({ event, onSelect, selected }: { event: ApiRunEvent; onSelect: () => void; selected: boolean }) {
  return <button aria-pressed={selected} className={`execution-event-row ${selected ? 'is-selected' : ''}`} onClick={onSelect} type="button"><span className={`execution-event-index ${eventTone(event.event_type)}`}>{String(event.sequence).padStart(2, '0')}</span><span className="execution-event-copy"><strong>{formatEventName(event.event_type)}</strong><small>{formatDate(event.created_at)} · {eventCategory(event.event_type)}</small></span><Icon name="chevron-right" size={15} /></button>
}

function EmptyTimeline({ hasEvents }: { hasEvents: boolean }) {
  return <div className="empty-panel"><Icon name={hasEvents ? 'search' : 'clock'} size={18} /><span>{hasEvents ? 'No persisted events match this filter.' : 'No persisted events have been returned yet.'}</span></div>
}

function EventDetails({ event }: { event: ApiRunEvent | null }) {
  return <section aria-label="Selected event details" className="panel event-details-panel"><div className="panel-heading"><div><span className="section-kicker">Selected event</span><h2>{event ? formatEventName(event.event_type) : 'No event selected'}</h2></div>{event && <span className="muted-label">seq {event.sequence}</span>}</div>{event ? <><div className="event-detail-meta"><ConfigRow label="Event id" value={event.id} /><ConfigRow label="Schema" value={`v${event.schema_version}`} /><ConfigRow label="Recorded" value={formatDate(event.created_at)} /></div><pre className="event-payload"><code>{JSON.stringify(event.payload, null, 2)}</code></pre></> : <p className="event-details-empty">Select a returned event to inspect its exact payload.</p>}</section>
}

function PersistedReportSummary({ report, run }: { report: ApiReport; run: ApiRun }) {
  const passed = report.evaluation.passed
  return <section className="panel persisted-report-summary"><div className="panel-heading"><div><span className="section-kicker">Terminal report</span><h2>Persisted evaluation result</h2></div><button className="button button-quiet" onClick={() => downloadReport(run)} type="button"><Icon name="download" size={15} /> Export JSON</button></div><div className="report-summary-content"><div className={`report-result-pill ${passed ? 'report-result-pass' : 'report-result-fail'}`}><Icon name={passed ? 'check' : 'warning'} size={15} /><strong>{passed ? 'Passed' : 'Failed'}</strong><span>{report.evaluation.invariants.filter((item) => item.passed).length}/{report.evaluation.invariants.length || 0} invariants</span></div><div className="report-summary-facts"><ConfigRow label="Trace events" value={String(report.trace.length)} /><ConfigRow label="Ledger entries" value={String(report.ledger.entries.length)} /><ConfigRow label="Findings" value={String(report.evaluation.findings.length)} /></div></div></section>
}

function ApiReportEvidence({ report }: { report: ApiReport }) {
  return <>
    <div className="run-detail-grid execution-report-grid">
      <section className="panel evaluators-panel"><div className="panel-heading"><div><span className="section-kicker">Independent checks</span><h2>Evaluator breakdown</h2></div><span className="muted-label">{report.evaluation.invariants.length} invariants</span></div><div className="evaluator-list">{report.evaluation.invariants.length ? report.evaluation.invariants.map((invariant) => <ApiInvariantRow invariant={invariant} key={invariant.name} />) : <div className="empty-panel">No invariant results recorded.</div>}</div></section>
      <section className="panel config-panel"><div className="panel-heading"><div><span className="section-kicker">Execution context</span><h2>Persisted configuration</h2></div></div><div className="config-list"><ConfigRow label="Agent" value={report.agent_name} /><ConfigRow label="Scenario" value={formatScenario(report.scenario)} /><ConfigRow label="Order" value={report.order.order_id} /><ConfigRow label="Final state" value={report.order.status} /></div></section>
    </div>
    <section className="panel api-evidence-panel"><div className="panel-heading"><div><span className="section-kicker">Persisted evidence</span><h2>Ledger and trace</h2></div><span className="muted-label">report JSON</span></div><div className="evidence-columns"><div><h3>Ledger entries</h3>{report.ledger.entries.length ? <div className="ledger-list">{report.ledger.entries.map((entry) => <div className="ledger-entry" key={entry.entry_id}><span className="ledger-entry-icon"><Icon name={entry.entry_type === 'charge' ? 'database' : 'arrow-right'} size={14} /></span><span><strong>{entry.entry_id}</strong><small>{entry.entry_type} · {entry.payment_id} · key {entry.idempotency_key}</small></span><b>{entry.amount} {entry.currency}</b></div>)}</div> : <EmptyPanel description="No ledger entries recorded." />}</div><div><h3>Trace events</h3>{report.trace.length ? <div className="trace-list">{report.trace.map((event) => <div className="trace-entry" key={`${event.index}-${event.event_type}`}><span className="trace-index">{String(event.index).padStart(2, '0')}</span><span><strong>{event.event_type}</strong><small>{formatAttributes(event.attributes)}</small></span></div>)}</div> : <EmptyPanel description="No trace events recorded." />}</div></div></section>
    <ReportFindings findings={report.evaluation.findings} />
  </>
}

function ApiInvariantRow({ invariant }: { invariant: ApiEvaluation['invariants'][number] }) {
  return <div className="evaluator-row"><span className={`evaluator-icon ${invariant.passed ? 'evaluator-pass' : 'evaluator-attention'}`}><Icon name={invariant.passed ? 'check' : 'warning'} size={15} /></span><span className="evaluator-copy"><strong>{invariant.name}</strong><span>{invariant.evidence.length ? invariant.evidence.join(' · ') : 'No evidence recorded.'}</span></span><span className={`evaluator-score ${invariant.passed ? '' : 'negative'}`}><strong>{invariant.passed ? 'PASS' : 'FAIL'}</strong><small>{invariant.evidence.length} evidence</small></span></div>
}

function ReportFindings({ findings }: { findings: ApiEvaluation['findings'] }) {
  return <section className="panel findings-panel"><div className="panel-heading"><div><span className="section-kicker">Evaluation findings</span><h2>What needs attention</h2></div><span className="muted-label">{findings.length} findings</span></div>{findings.length ? <div className="finding-list">{findings.map((finding) => <article className={`finding-card ${finding.severity.toLowerCase() === 'error' ? 'finding-error' : ''}`} key={finding.code}><div className="finding-heading"><Icon name={finding.severity.toLowerCase() === 'error' ? 'warning' : 'activity'} size={15} /><strong>{finding.title}</strong><span className="finding-code">{finding.code} · {finding.severity}</span></div><p>{finding.recommendation}</p>{finding.evidence.length > 0 && <small>{finding.evidence.join(' · ')}</small>}</article>)}</div> : <div className="success-empty"><Icon name="check" size={17} /><span>No findings recorded for this report.</span></div>}</section>
}

function EmptyPanel({ description }: { description: string }) {
  return <div className="empty-panel"><Icon name="layers" size={18} /><span>{description}</span></div>
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
  anchor.href = url
  anchor.download = `${run.id}-report.json`
  anchor.click()
  URL.revokeObjectURL(url)
}
