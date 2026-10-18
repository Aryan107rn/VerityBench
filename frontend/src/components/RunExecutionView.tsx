import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import type { ApiClient, ApiEvaluation, ApiReport, ApiRun, ApiRunEvent } from '../lib/api'
import type { RunStatus } from '../types'

type ExecutionState = Exclude<RunStatus, 'completed' | 'needs-review'>
type EventFilter = 'all' | 'lifecycle' | 'agent' | 'payment' | 'order'

const executionStates = new Set<ExecutionState>([
  'queued',
  'running',
  'cancel_requested',
  'passed',
  'failed',
  'timed_out',
  'inconclusive',
  'cancelled',
])
const terminalStates = new Set<ExecutionState>(['cancelled', 'passed', 'failed', 'timed_out', 'inconclusive'])

function normalizeState(state: string): ExecutionState {
  return executionStates.has(state as ExecutionState) ? state as ExecutionState : 'inconclusive'
}

function displayState(run: ApiRun): ExecutionState {
  const state = normalizeState(run.state)
  return run.cancel_requested && (state === 'queued' || state === 'running') ? 'cancel_requested' : state
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

function timestamp(value: string | null) {
  if (!value) return null
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? milliseconds : null
}

function formatElapsed(milliseconds: number) {
  const sign = milliseconds < 0 ? '−' : ''
  const absolute = Math.abs(milliseconds)
  if (absolute < 1000) return `${sign}${Math.round(absolute)} ms`
  if (absolute < 60_000) return `${sign}${(absolute / 1000).toFixed(1)} s`
  return `${sign}${Math.floor(absolute / 60_000)}m ${Math.round((absolute % 60_000) / 1000)}s`
}

function relativeTimestamp(value: string, baseline: string | null) {
  const eventTime = timestamp(value)
  const baselineTime = timestamp(baseline)
  if (eventTime === null || baselineTime === null) return 'relative time unavailable'
  const delta = eventTime - baselineTime
  return delta >= 0 ? `+${formatElapsed(delta)}` : formatElapsed(delta)
}

function observedTiming(run: ApiRun, now: number) {
  const started = timestamp(run.started_at)
  const completed = timestamp(run.completed_at)
  if (started !== null && completed !== null && completed >= started) {
    return { label: 'Observed duration', value: formatElapsed(completed - started), detail: 'started → completed' }
  }
  if (started !== null && !isTerminal(run.state)) {
    return { label: 'Elapsed since start', value: formatElapsed(Math.max(0, now - started)), detail: 'live wall-clock observation' }
  }
  return { label: 'Timing', value: 'Unavailable', detail: 'API timestamps are missing' }
}

function stateLabel(state: ExecutionState) {
  const label = state.replaceAll('_', ' ')
  return label.charAt(0).toUpperCase() + label.slice(1)
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
  const [copiedPayload, setCopiedPayload] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const timelineRef = useRef<HTMLDivElement>(null)
  const onRunUpdatedRef = useRef(onRunUpdated)
  const executionState = displayState(run)

  useEffect(() => {
    setRun(initialRun)
  }, [initialRun])

  useEffect(() => {
    onRunUpdatedRef.current = onRunUpdated
  }, [onRunUpdated])

  useEffect(() => {
    if (executionState !== 'running' && executionState !== 'queued' && executionState !== 'cancel_requested') return
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [executionState])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    let latestSequence = -1
    let currentState = normalizeState(initialRun.state)
    setRun(initialRun)
    setEvents([])
    setSelectedSequence(null)
    setLoading(true)
    setError('')

    const publishRun = (nextRun: ApiRun) => {
      if (!active) return
      currentState = displayState(nextRun)
      setRun(nextRun)
      onRunUpdatedRef.current?.(nextRun)
    }

    const ingestEvent = (event: ApiRunEvent) => {
      if (!active || event.run_id !== initialRun.id || event.sequence <= latestSequence) return
      latestSequence = event.sequence
      setEvents((current) => current.some((item) => item.sequence === event.sequence) ? current : [...current, event].sort((a, b) => a.sequence - b.sequence))
      const eventState = event.payload.state
      if (typeof eventState === 'string') {
        const normalized = normalizeState(eventState)
        currentState = event.payload.cancel_requested === true && (normalized === 'queued' || normalized === 'running') ? 'cancel_requested' : normalized
      }
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
  const timing = observedTiming(run, now)
  const baseline = run.started_at ?? run.created_at

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

  const copySelectedPayload = async () => {
    if (!selectedEvent) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(selectedEvent.payload, null, 2))
      setCopiedPayload(true)
      window.setTimeout(() => setCopiedPayload(false), 1600)
    } catch {
      setCopiedPayload(false)
    }
  }

  const cancelDisabled = cancelBusy || run.cancel_requested || executionState === 'cancel_requested' || isTerminal(run.state)
  return (
    <>
      <button className="back-button" onClick={onBack} type="button"><Icon name="arrow-left" size={16} /> Back to runs</button>
      <div className="run-detail-header execution-header">
        <div>
          <div className="run-id-line"><span className="run-id-badge">{run.id}</span><ExecutionBadge state={executionState} /></div>
          <h1>{isTerminal(run.state) ? 'Run execution' : 'Live execution'}</h1>
          <p>{run.agent} <span>·</span> {formatScenario(run.scenario)} <span>·</span> started {formatDate(run.started_at ?? run.created_at)}</p>
        </div>
        <div className="run-detail-actions">
          <span className="local-label execution-source-label"><Icon name="shield" size={13} /> API · persisted run</span>
          <span className={`transport-pill transport-${transport}`}><span />{transport === 'stream' ? 'Live stream' : transport === 'polling' ? 'Polling fallback' : 'History loaded'}</span>
          <button className="button button-quiet" disabled={refreshing} onClick={refresh} type="button"><Icon name="refresh" size={15} /> Refresh history</button>
          {!isTerminal(run.state) && <button className="button button-danger" disabled={cancelDisabled} onClick={() => void cancel()} type="button">{cancelBusy ? 'Cancelling…' : 'Cancel run'}</button>}
        </div>
      </div>

      {error && <div className="inline-error execution-error" role="alert">{error}</div>}
      <section aria-label="Execution status" className="execution-status-grid">
        <div className={`execution-state-card execution-state-${executionState}`}><span className="section-kicker">Execution state</span><strong>{stateLabel(executionState)}</strong><span>{stateDescription(executionState)}</span></div>
        <div className="execution-context-card execution-timing-card"><span className="section-kicker">{timing.label}</span><strong>{timing.value}</strong><span>{timing.detail}</span></div>
        <div className="execution-context-card"><span className="section-kicker">Scenario</span><strong>{formatScenario(run.scenario)}</strong><span>{latestEvent ? `Latest: ${formatEventName(latestEvent.event_type)}` : 'Waiting for the first persisted event'}</span></div>
        <div className="execution-context-card"><span className="section-kicker">Observed history</span><strong>{events.length} events</strong><span>{run.completed_at ? `Finished ${formatDate(run.completed_at)}` : 'Durable events received so far'}</span></div>
      </section>

      <section className="panel execution-progress-panel">
        <div className="panel-heading"><div><span className="section-kicker">Observed execution</span><h2>{latestEvent ? formatEventName(latestEvent.event_type) : 'Waiting for worker'}</h2></div><span className="muted-label">{events.length} persisted events · no estimated steps</span></div>
        <div aria-label={`${events.length} persisted events observed; execution is ${stateLabel(executionState)}`} className={`execution-progress-track ${isTerminal(executionState) ? 'execution-progress-complete' : 'execution-progress-live'}`}><span /></div>
        <p className="execution-progress-note">The signal shows transport activity only. Event count and timing come from API records; no intermediate steps, percentage, or span is inferred.</p>
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
             {loading ? <div className="empty-panel" role="status">Loading persisted events…</div> : filteredEvents.length ? filteredEvents.map((event) => <EventRow baseline={baseline} event={event} key={event.sequence} onSelect={() => setSelectedSequence(event.sequence)} previousEvent={events[events.findIndex((item) => item.sequence === event.sequence) - 1] ?? null} selected={selectedEvent?.sequence === event.sequence} />) : <EmptyTimeline hasEvents={events.length > 0} />}
           </div>
         </section>

         <EventDetails baseline={baseline} copied={copiedPayload} event={selectedEvent} onCopy={() => void copySelectedPayload()} />
       </div>

       {run.report && <PersistedReportSummary report={run.report} run={run} />}
       {run.report ? <ApiReportEvidence report={run.report} /> : <MissingReportState run={run} state={executionState} />}
    </>
  )
}

function ExecutionBadge({ state }: { state: ExecutionState }) {
  return <span className={`execution-badge execution-badge-${state}`}><span className="status-dot" />{stateLabel(state)}</span>
}

function stateDescription(state: ExecutionState) {
  if (state === 'queued') return 'Waiting for an execution worker'
  if (state === 'running') return 'Worker is emitting durable events'
  if (state === 'cancel_requested') return 'Cancellation requested; waiting for a terminal event'
  if (state === 'cancelled') return 'Execution stopped before completion'
  if (state === 'passed') return 'All persisted evaluation invariants passed'
  if (state === 'timed_out') return 'Execution exceeded its allowed time'
  if (state === 'inconclusive') return 'Execution ended without a conclusive evaluation'
  return 'Execution completed with a failed evaluation'
}

function EventRow({ baseline, event, onSelect, previousEvent, selected }: { baseline: string | null; event: ApiRunEvent; onSelect: () => void; previousEvent: ApiRunEvent | null; selected: boolean }) {
  const currentTime = timestamp(event.created_at)
  const previousTime = previousEvent ? timestamp(previousEvent.created_at) : null
  const eventGap = currentTime !== null && previousTime !== null && currentTime >= previousTime ? currentTime - previousTime : null
  return <button aria-pressed={selected} className={`execution-event-row ${selected ? 'is-selected' : ''}`} onClick={onSelect} type="button"><span className={`execution-event-index ${eventTone(event.event_type)}`}>{String(event.sequence).padStart(2, '0')}</span><span className="execution-event-copy"><strong>{formatEventName(event.event_type)}</strong><small><span className="event-relative-time">{relativeTimestamp(event.created_at, baseline)}</span> · {formatDate(event.created_at)} · {eventCategory(event.event_type)}{eventGap !== null ? ` · +${formatElapsed(eventGap)} since previous` : ''}</small></span><Icon name="chevron-right" size={15} /></button>
}

function EmptyTimeline({ hasEvents }: { hasEvents: boolean }) {
  return <div className="empty-panel"><Icon name={hasEvents ? 'search' : 'clock'} size={18} /><span>{hasEvents ? 'No persisted events match this filter.' : 'No persisted events have been returned yet.'}</span></div>
}

function EventDetails({ baseline, copied, event, onCopy }: { baseline: string | null; copied: boolean; event: ApiRunEvent | null; onCopy: () => void }) {
  return <section aria-label="Selected event details" className="panel event-details-panel"><div className="panel-heading"><div><span className="section-kicker">Selected event</span><h2>{event ? formatEventName(event.event_type) : 'No event selected'}</h2></div>{event && <span className="muted-label">seq {event.sequence}</span>}</div>{event ? <><div className="event-detail-meta"><ConfigRow label="Event id" value={event.id} /><ConfigRow label="Schema" value={`v${event.schema_version}`} /><ConfigRow label="Relative" value={relativeTimestamp(event.created_at, baseline)} /><ConfigRow label="Recorded" value={formatDate(event.created_at)} /></div><div className="payload-heading"><span className="section-kicker">Exact payload</span><button className="copy-payload-button" onClick={onCopy} type="button"><Icon name={copied ? 'check' : 'copy'} size={13} /> {copied ? 'Copied' : 'Copy payload'}</button></div><pre className="event-payload"><code>{JSON.stringify(event.payload, null, 2)}</code></pre></> : <p className="event-details-empty">Select a returned event to inspect its exact payload.</p>}</section>
}

function MissingReportState({ run, state }: { run: ApiRun; state: ExecutionState }) {
  const terminal = isTerminal(run.state)
  const hasError = Boolean(run.error_message)
  return <section className={`panel report-state-panel ${terminal || hasError ? 'report-state-error' : 'report-state-pending'}`} role={terminal || hasError ? 'alert' : undefined}><div className="report-state-icon"><Icon name={terminal || hasError ? 'warning' : 'clock'} size={18} /></div><div><span className="section-kicker">{terminal ? 'Missing terminal report' : 'Report availability'}</span><h2>{terminal ? 'No persisted report was returned' : 'Report not available yet'}</h2><p>{run.error_message ?? (terminal ? `The run is ${stateLabel(state)}, but the API did not include report data. Inspect the durable events and server error before treating this as a pass or fail.` : 'The worker has not produced a terminal report. Durable events above remain the source of truth while execution is in progress.')}</p></div></section>
}

function PersistedReportSummary({ report, run }: { report: ApiReport; run: ApiRun }) {
  const passed = report.evaluation.passed
  return <section className="panel persisted-report-summary"><div className="panel-heading"><div><span className="section-kicker">Terminal report</span><h2>Persisted evaluation result</h2></div><button className="button button-quiet" onClick={() => downloadReport(run)} type="button"><Icon name="download" size={15} /> Export JSON</button></div><div className="report-summary-content"><div className={`report-result-pill ${passed ? 'report-result-pass' : 'report-result-fail'}`}><Icon name={passed ? 'check' : 'warning'} size={15} /><strong>{passed ? 'Passed' : 'Failed'}</strong><span>{report.evaluation.invariants.filter((item) => item.passed).length}/{report.evaluation.invariants.length || 0} invariants</span></div><div className="report-summary-facts"><ConfigRow label="Trace events" value={String(report.trace.length)} /><ConfigRow label="Ledger entries" value={String(report.ledger.entries.length)} /><ConfigRow label="Findings" value={String(report.evaluation.findings.length)} /></div></div></section>
}

function ApiReportEvidence({ report }: { report: ApiReport }) {
  return <>
    <section className="panel report-metrics-panel"><div className="panel-heading"><div><span className="section-kicker">Result metrics</span><h2>Observed execution counters</h2></div><span className="muted-label">report.metrics</span></div><div className="execution-metrics-grid"><ReportMetric label="Payment attempts" value={report.metrics.payment_attempts} /><ReportMetric label="Retries" value={report.metrics.retries} /><ReportMetric label="Successful payments" value={report.metrics.successful_payments} /><ReportMetric label="Timeouts" value={report.metrics.timeouts} /><ReportMetric label="Malformed responses" value={report.metrics.malformed_responses} /><ReportMetric label="Temporary failures" value={report.metrics.temporary_failures} /><ReportMetric label="Reconciliations" value={report.metrics.reconciliations} /><ReportMetric label="Duplicate charges" value={report.metrics.duplicate_charges} /><ReportMetric label="Fulfilled orders" value={report.metrics.fulfilled_orders} /><ReportMetric label="Cancelled orders" value={report.metrics.cancelled_orders} /></div></section>
    <div className="run-detail-grid execution-report-grid">
      <section className="panel evaluators-panel"><div className="panel-heading"><div><span className="section-kicker">Independent checks</span><h2>Evaluator breakdown</h2></div><span className="muted-label">{report.evaluation.invariants.length} invariants</span></div><div className="evaluator-list">{report.evaluation.invariants.length ? report.evaluation.invariants.map((invariant) => <ApiInvariantRow invariant={invariant} key={invariant.name} />) : <div className="empty-panel">No invariant results recorded.</div>}</div></section>
      <section className="panel config-panel"><div className="panel-heading"><div><span className="section-kicker">Execution context</span><h2>Persisted configuration</h2></div></div><div className="config-list"><ConfigRow label="Agent" value={report.agent_name} /><ConfigRow label="Scenario" value={formatScenario(report.scenario)} /><ConfigRow label="Order" value={report.order.order_id} /><ConfigRow label="Final state" value={report.order.status} /></div></section>
    </div>
    <section className="panel api-evidence-panel"><div className="panel-heading"><div><span className="section-kicker">Persisted evidence</span><h2>Ledger and trace</h2></div><span className="muted-label">report JSON</span></div><div className="evidence-columns"><div><h3>Ledger entries</h3>{report.ledger.entries.length ? <div className="ledger-list">{report.ledger.entries.map((entry) => <div className="ledger-entry" key={entry.entry_id}><span className="ledger-entry-icon"><Icon name={entry.entry_type === 'charge' ? 'database' : 'arrow-right'} size={14} /></span><span><strong>{entry.entry_id}</strong><small>{entry.entry_type} · {entry.payment_id} · key {entry.idempotency_key}</small></span><b>{entry.amount} {entry.currency}</b></div>)}</div> : <EmptyPanel description="No ledger entries recorded." />}</div><div><h3>Trace events</h3>{report.trace.length ? <div className="trace-list">{report.trace.map((event) => <div className="trace-entry" key={`${event.index}-${event.event_type}`}><span className="trace-index">{String(event.index).padStart(2, '0')}</span><span><strong>{event.event_type}</strong><small>{formatAttributes(event.attributes)}</small></span></div>)}</div> : <EmptyPanel description="No trace events recorded." />}</div></div></section>
    <ReportFindings findings={report.evaluation.findings} />
  </>
}

function ReportMetric({ label, value }: { label: string; value: number }) {
  return <div className="report-metric"><span>{label}</span><strong>{String(value)}</strong></div>
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
