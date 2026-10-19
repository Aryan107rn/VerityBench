import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import type { ApiClient, ApiEvaluation, ApiReport, ApiRun, ApiRunEvent } from '../lib/api'
import type { RunStatus } from '../types'
import './trace-inspector.css'

type ExecutionState = Exclude<RunStatus, 'completed' | 'needs-review'>
type EventFilter = 'all' | 'lifecycle' | 'agent' | 'payment' | 'order'
type ReportSection = 'trace' | 'evaluation' | 'ledger' | 'findings'
type InspectorTab = 'overview' | 'attributes' | 'json'

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
  if (value.includes('failed') || value.includes('cancel') || value.includes('timed_out')) return 'ti-category-warning'
  if (value.startsWith('run_')) return 'event-lifecycle'
  if (value.startsWith('agent_')) return 'event-agent'
  if (value.startsWith('payment_')) return 'ti-category-payment'
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
  const [section, setSection] = useState<ReportSection>('trace')
  const [now, setNow] = useState(() => Date.now())
  const timelineRef = useRef<HTMLDivElement>(null)
  const onRunUpdatedRef = useRef(onRunUpdated)
  const sectionId = useId()
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
        setRefreshing(false)
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
          setRefreshing(false)
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
  const selectedEvent = filteredEvents.find((event) => event.sequence === selectedSequence) ?? filteredEvents[filteredEvents.length - 1] ?? null
  const latestEvent = events[events.length - 1] ?? null
  const selectedIndex = selectedEvent ? filteredEvents.findIndex((event) => event.sequence === selectedEvent.sequence) : -1
  const previousEvent = selectedEvent ? events[events.findIndex((event) => event.sequence === selectedEvent.sequence) - 1] ?? null : null
  const timing = observedTiming(run, now)
  const baseline = run.started_at ?? run.created_at
  const terminal = isTerminal(run.state)
  const transportLabel = loading ? 'Loading history' : terminal ? 'Persisted history' : transport === 'stream' ? 'Live stream' : transport === 'polling' ? 'Polling fallback' : 'History loaded'

  useEffect(() => {
    if (selectedSequence !== null && filteredEvents.some((event) => event.sequence === selectedSequence)) return
    setSelectedSequence(filteredEvents[filteredEvents.length - 1]?.sequence ?? null)
  }, [filteredEvents, selectedSequence])

  useEffect(() => {
    if (autoScroll && timelineRef.current) timelineRef.current.scrollTop = timelineRef.current.scrollHeight
  }, [autoScroll, filteredEvents.length, section])

  const refresh = () => {
    setRefreshing(true)
    setReloadNonce((current) => current + 1)
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

  const cancelDisabled = cancelBusy || run.cancel_requested || executionState === 'cancel_requested' || isTerminal(run.state)
  return (
    <div className="trace-inspector">
      <div className="ti-breadcrumb-bar">
        <button className="back-button" onClick={onBack} type="button"><Icon name="arrow-left" size={14} /> Back to runs</button>
        <span className="local-label execution-source-label"><Icon name="shield" size={12} /> API · persisted run</span>
      </div>
      <header className="ti-header">
        <div className="ti-heading-copy">
          <div className="ti-title-line"><span className="ti-title-icon"><Icon name="activity" size={18} /></span><h1>{terminal ? 'Run execution' : 'Live execution'}</h1><ExecutionBadge state={executionState} /></div>
          <p className="ti-run-id">{run.id}</p>
          <p className="ti-context"><strong>{run.agent}</strong><span aria-hidden="true">/</span>{formatScenario(run.scenario)}</p>
        </div>
        <div className="ti-actions">
          <span className={`transport-pill transport-${terminal || loading ? 'history' : transport}`} role="status"><span />{transportLabel}</span>
          <button className="ti-button" disabled={refreshing || loading} onClick={refresh} type="button"><Icon name="refresh" size={13} />{refreshing ? 'Refreshing…' : 'Refresh history'}</button>
          {run.report && <button className="ti-button" onClick={() => downloadReport(run)} type="button"><Icon name="download" size={13} /> Export JSON</button>}
          {!terminal && <button className="ti-button ti-button-danger" disabled={cancelDisabled} onClick={() => void cancel()} type="button">{cancelBusy ? 'Cancelling…' : executionState === 'cancel_requested' ? 'Cancellation requested' : 'Cancel run'}</button>}
        </div>
      </header>

      {error && <div className="inline-error" role="alert">{error}</div>}
      <section aria-label="Execution status" className="ti-status-strip">
        <div><span className="ti-label">Execution state</span><strong>{stateLabel(executionState)}</strong><small>{stateDescription(executionState)}</small></div>
        <div><span className="ti-label">{timing.label}</span><strong className="ti-mono">{timing.value}</strong><small>{timing.detail}</small></div>
        <div><span className="ti-label">Persisted events</span><strong className="ti-mono">{events.length}<small> records</small></strong><small>{loading ? 'Loading durable history' : 'Ordered by API sequence'}</small></div>
        <div><span className="ti-label">Latest recorded event</span><strong className="ti-latest-event">{latestEvent?.event_type ?? 'Waiting for events'}</strong><small>{latestEvent ? `${relativeTimestamp(latestEvent.created_at, baseline)} · seq ${latestEvent.sequence}` : 'No persisted events returned'}</small></div>
      </section>

      <div className="ti-workbench">
        <div className="ti-section-nav">
          <InspectorTabs active={section} id={sectionId} label="Run evidence sections" onChange={setSection} options={[
            { value: 'trace', label: 'Trace', count: events.length },
            { value: 'evaluation', label: 'Evaluation', count: run.report?.evaluation.invariants.length },
            { value: 'ledger', label: 'Ledger', count: run.report?.ledger.entries.length },
            { value: 'findings', label: 'Findings', count: run.report?.evaluation.findings.length },
          ]} />
          <span className="ti-nav-source">Persisted evidence</span>
        </div>
        <section aria-labelledby={`${sectionId}-tab-trace`} className="ti-tab-panel" hidden={section !== 'trace'} id={`${sectionId}-panel-trace`} role="tabpanel" tabIndex={0}>
          <div className="ti-workspace">
            <section aria-label="Durable event log" className="ti-event-pane">
              <div className="ti-pane-heading"><h2><Icon name="layers" size={14} /> Event timeline</h2><span className="ti-count">{filteredEvents.length} / {events.length}</span></div>
              <div className="ti-event-toolbar">
                <label className="ti-search"><Icon name="search" size={14} /><span className="sr-only">Search events</span><input onChange={(event) => setQuery(event.target.value)} placeholder="Search events or payload…" type="search" value={query} /></label>
                <div className="ti-filter-row">
                  <label className="ti-filter"><span className="sr-only">Filter event category</span><select onChange={(event) => setFilter(event.target.value as EventFilter)} value={filter}><option value="all">All categories</option><option value="lifecycle">Lifecycle</option><option value="agent">Agent</option><option value="payment">Payment</option><option value="order">Order and ledger</option></select><Icon name="chevron-down" size={12} /></label>
                  <button aria-pressed={autoScroll} className={`ti-button ti-auto-scroll ${autoScroll ? 'is-active' : ''}`} onClick={() => setAutoScroll((current) => !current)} type="button"><Icon name={autoScroll ? 'activity' : 'clock'} size={12} />{autoScroll ? 'Auto-scroll on' : 'Auto-scroll paused'}</button>
                </div>
              </div>
              <div className="ti-list-heading"><span>Sequence / event</span><span>Recorded offset</span></div>
              <div aria-busy={loading} aria-label="Run event timeline" aria-live="off" className="ti-event-list" ref={timelineRef} role="log" tabIndex={0}>
                {loading ? <div className="ti-empty" role="status"><Icon name="refresh" size={20} /><strong>Loading persisted events…</strong></div> : filteredEvents.length ? filteredEvents.map((event) => <EventRow baseline={baseline} event={event} key={event.sequence} onSelect={() => setSelectedSequence(event.sequence)} selected={selectedEvent?.sequence === event.sequence} />) : <EmptyTimeline hasEvents={events.length > 0} />}
              </div>
              <div className="ti-event-footer"><span className="ti-record-dot" />Flat records · sequence order{(query || filter !== 'all') && <button className="ti-text-button" onClick={() => { setQuery(''); setFilter('all') }} type="button">Clear filters</button>}</div>
            </section>

            <EventDetails event={selectedEvent} hasEvents={events.length > 0} key={run.id} loading={loading} onNext={() => setSelectedSequence(filteredEvents[selectedIndex + 1]?.sequence ?? null)} onPrevious={() => setSelectedSequence(filteredEvents[selectedIndex - 1]?.sequence ?? null)} selectedIndex={selectedIndex} visibleCount={filteredEvents.length} />
            <MetadataRail baseline={baseline} event={selectedEvent} previousEvent={previousEvent} run={run} state={executionState} />
          </div>
          <div className="ti-provenance"><Icon name="database" size={12} /><span>API event records · offsets from run {run.started_at ? 'start' : 'creation'} · category markers describe event types, not parent spans.</span><span>{run.completed_at ? `Finished ${formatDate(run.completed_at)}` : 'Recorded timestamps only'}</span></div>
          {run.report ? <PersistedTrace report={run.report} /> : <MissingReportState run={run} state={executionState} />}
        </section>
        {(['evaluation', 'ledger', 'findings'] as const).map((value) => (
          <section
            aria-labelledby={`${sectionId}-tab-${value}`}
            className="ti-tab-panel ti-report-content"
            hidden={section !== value}
            id={`${sectionId}-panel-${value}`}
            key={value}
            role="tabpanel"
            tabIndex={0}
          >
            <ReportSectionContent run={run} section={value} state={executionState} />
          </section>
        ))}
      </div>
    </div>
  )
}

function InspectorTabs<T extends string>({ active, id, label, onChange, options }: { active: T; id: string; label: string; onChange: (value: T) => void; options: Array<{ value: T; label: string; count?: number }> }) {
  return (
    <div aria-label={label} className="ti-tabs" role="tablist">
      {options.map((option, index) => (
        <button
          aria-controls={`${id}-panel-${option.value}`}
          aria-selected={active === option.value}
          id={`${id}-tab-${option.value}`}
          key={option.value}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            const nextIndex = event.key === 'ArrowRight' ? (index + 1) % options.length
              : event.key === 'ArrowLeft' ? (index - 1 + options.length) % options.length
                : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : null
            if (nextIndex === null) return
            event.preventDefault()
            onChange(options[nextIndex].value)
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus()
          }}
          role="tab"
          tabIndex={active === option.value ? 0 : -1}
          type="button"
        >
          {option.label}
          {option.count !== undefined && <span className="ti-tab-count">{option.count}</span>}
        </button>
      ))}
    </div>
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

function EventRow({ baseline, event, onSelect, selected }: { baseline: string | null; event: ApiRunEvent; onSelect: () => void; selected: boolean }) {
  const category = eventCategory(event.event_type)
  return <button aria-pressed={selected} className={`ti-event-row ${selected ? 'is-selected' : ''}`} onClick={onSelect} title={`Sequence ${event.sequence} · ${event.event_type} · ${event.created_at}`} type="button">
    <span className="ti-event-sequence">{event.sequence}</span>
    <span aria-hidden="true" className={`ti-category-marker ${eventTone(event.event_type)}`}><Icon name={category === 'lifecycle' ? 'activity' : category === 'agent' ? 'terminal' : category === 'payment' ? 'database' : 'layers'} size={12} /></span>
    <span className="ti-event-copy"><strong>{event.event_type}</strong><small>{category}</small></span>
    <span className="ti-event-offset">{relativeTimestamp(event.created_at, baseline)}</span>
  </button>
}

function EmptyTimeline({ hasEvents }: { hasEvents: boolean }) {
  return <div className="ti-empty"><Icon name={hasEvents ? 'search' : 'clock'} size={22} /><strong>{hasEvents ? 'No matching events' : 'No events recorded yet'}</strong><span>{hasEvents ? 'Try a different category or search term.' : 'Persisted events will appear here when returned by the API.'}</span></div>
}

function EventDetails({ event, hasEvents, loading, onNext, onPrevious, selectedIndex, visibleCount }: { event: ApiRunEvent | null; hasEvents: boolean; loading: boolean; onNext: () => void; onPrevious: () => void; selectedIndex: number; visibleCount: number }) {
  const [tab, setTab] = useState<InspectorTab>('overview')
  const [wrap, setWrap] = useState(true)
  const [copyFeedback, setCopyFeedback] = useState<{ id: string; status: 'copied' | 'error' } | null>(null)
  const id = useId()
  const feedback = event?.id === copyFeedback?.id ? copyFeedback?.status : null

  useEffect(() => {
    if (!copyFeedback) return
    const timeout = window.setTimeout(() => setCopyFeedback(null), 2000)
    return () => window.clearTimeout(timeout)
  }, [copyFeedback])

  const copyPayload = async () => {
    if (!event) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(event.payload, null, 2))
      setCopyFeedback({ id: event.id, status: 'copied' })
    } catch {
      setCopyFeedback({ id: event.id, status: 'error' })
    }
  }

  return <section aria-label="Selected event details" className="ti-inspector-pane">
    <div className="ti-pane-heading"><h2><Icon name="code" size={14} /> Event inspector</h2><div className="ti-event-navigation"><span>{selectedIndex < 0 ? '0' : selectedIndex + 1} / {visibleCount}</span><button aria-label="Inspect previous visible event" className="ti-icon-button" disabled={loading || selectedIndex <= 0} onClick={onPrevious} type="button"><Icon name="arrow-left" size={13} /></button><button aria-label="Inspect next visible event" className="ti-icon-button" disabled={loading || selectedIndex < 0 || selectedIndex >= visibleCount - 1} onClick={onNext} type="button"><Icon name="arrow-right" size={13} /></button></div></div>
    <div className="ti-selected-heading"><span className="ti-label">{event ? `Sequence ${event.sequence} · ${eventCategory(event.event_type)}` : 'Persisted event record'}</span><h3>{event?.event_type ?? (loading ? 'Loading history…' : 'No event selected')}</h3><p>{event ? formatEventName(event.event_type) : 'Select an event from the timeline to inspect its payload.'}</p></div>
    <InspectorTabs active={tab} id={id} label="Event inspector views" onChange={setTab} options={[{ value: 'overview', label: 'Overview' }, { value: 'attributes', label: 'Attributes' }, { value: 'json', label: 'JSON' }]} />
    <div className="ti-payload-toolbar"><span className="ti-label">{tab === 'attributes' ? 'Event record attributes' : 'Exact event payload'}</span><div>{tab === 'json' && <button aria-pressed={wrap} className={`ti-text-button ${wrap ? 'is-active' : ''}`} onClick={() => setWrap((current) => !current)} type="button">Wrap lines</button>}<button className="ti-button ti-copy-button" disabled={!event || loading} onClick={() => void copyPayload()} type="button"><Icon name={feedback === 'copied' ? 'check' : 'copy'} size={12} />{feedback === 'copied' ? 'Copied' : 'Copy payload'}</button></div></div>
    <span className={`ti-copy-feedback ${feedback === 'error' ? 'ti-copy-error' : 'sr-only'}`} role="status">{feedback === 'error' ? 'Could not copy the payload. You can select and copy the JSON directly.' : feedback === 'copied' ? 'Event payload copied to clipboard.' : ''}</span>
    {(['overview', 'attributes', 'json'] as const).map((value) => (
      <div
        aria-labelledby={`${id}-tab-${value}`}
        className="ti-inspector-content ti-tab-panel"
        hidden={tab !== value}
        id={`${id}-panel-${value}`}
        key={value}
        role="tabpanel"
        tabIndex={0}
      >
        <EventInspectorContent event={event} hasEvents={hasEvents} loading={loading} tab={value} wrap={wrap} />
      </div>
    ))}
    <div className="ti-inspector-footer"><Icon name="shield" size={12} /><span>{event ? `API record · schema v${event.schema_version} · event.payload` : 'Waiting for a selected API record'}</span></div>
  </section>
}

function EventInspectorContent({ event, hasEvents, loading, tab, wrap }: { event: ApiRunEvent | null; hasEvents: boolean; loading: boolean; tab: InspectorTab; wrap: boolean }) {
  if (!event) {
    return <div className="ti-empty ti-inspector-empty">
      <Icon name={loading ? 'refresh' : 'code'} size={28} />
      <strong>{loading ? 'Loading persisted history' : hasEvents ? 'No events match your filters' : 'Your event payload will appear here'}</strong>
      <span>{loading ? 'Fetching API records for this run.' : hasEvents ? 'Clear or adjust the timeline filters to inspect an event.' : 'Event details become available once the API returns a record.'}</span>
    </div>
  }

  if (tab === 'json') return <div className="ti-json-container"><JsonPayload payload={event.payload} wrap={wrap} /></div>

  if (tab === 'attributes') {
    return <>
      <div className="ti-content-intro"><h4>Record envelope</h4><p>API fields stored alongside the payload.</p></div>
      <dl className="ti-attribute-list">
        {Object.entries(event).filter(([key]) => key !== 'payload').map(([key, value]) => (
          <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>
        ))}
      </dl>
    </>
  }

  const entries = Object.entries(event.payload)
  return <>
    <div className="ti-content-intro"><h4>Payload fields <span className="ti-count">{entries.length}</span></h4><p>Values recorded in this event’s payload.</p></div>
    {entries.length ? (
      <dl className="ti-payload-fields">
        {entries.map(([key, value]) => (
          <div className="ti-payload-field" key={key}>
            <dt><code>{key}</code><span className="ti-value-type">{value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}</span></dt>
            <dd><PayloadValue value={value} /></dd>
          </div>
        ))}
      </dl>
    ) : <div className="ti-empty"><Icon name="code" size={20} /><strong>Empty payload</strong><span>The API recorded an empty object for this event.</span><code>{'{}'}</code></div>}
  </>
}

function PayloadValue({ value }: { value: unknown }) {
  if (value !== null && typeof value === 'object') return <pre className="ti-nested-value"><code>{JSON.stringify(value, null, 2)}</code></pre>
  return <span className={`ti-scalar ${typeof value === 'boolean' || value === null ? 'ti-scalar-literal' : ''}`}>{value === null ? 'null' : typeof value === 'string' && value.length === 0 ? '""' : String(value)}</span>
}

function JsonPayload({ payload, wrap }: { payload: Record<string, unknown>; wrap: boolean }) {
  const lines = JSON.stringify(payload, null, 2).split('\n')
  return (
    <pre aria-label="Exact event payload JSON" className={`ti-json ${wrap ? 'ti-json-wrap' : ''}`} tabIndex={0}>
      <code>{lines.map((line, index) => (
        <span className="ti-json-line" data-line={index + 1} key={index}>
          <span className="ti-json-text">
            {line.split(/("(?:\\.|[^"\\])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g).map((part, partIndex) => (
              <span className={part.startsWith('"') ? part.endsWith(':') ? 'ti-json-key' : 'ti-json-string' : /^(true|false|null|-?\d)/.test(part) ? 'ti-json-literal' : undefined} key={partIndex}>{part}</span>
            ))}
            {index < lines.length - 1 ? '\n' : ''}
          </span>
        </span>
      ))}</code>
    </pre>
  )
}

function MetadataRail({ baseline, event, previousEvent, run, state }: { baseline: string; event: ApiRunEvent | null; previousEvent: ApiRunEvent | null; run: ApiRun; state: ExecutionState }) {
  return <aside aria-label="Execution metadata" className="ti-metadata-pane">
    <div className="ti-pane-heading"><h2><Icon name="sliders" size={14} /> Metadata</h2></div>
    <div className="ti-metadata-section"><h3 className="ti-label">Selected event</h3>{event ? <>
      <ConfigRow label="Category" value={eventCategory(event.event_type)} />
      <ConfigRow label="Sequence" value={String(event.sequence)} />
      <ConfigRow label={`From run ${run.started_at ? 'start' : 'creation'}`} value={relativeTimestamp(event.created_at, baseline)} />
      <ConfigRow label="Since previous record" value={previousEvent ? relativeTimestamp(event.created_at, previousEvent.created_at) : 'First recorded event'} />
      <ConfigRow label="Schema" value={`v${event.schema_version}`} />
      <div className="ti-metadata-value"><span>Recorded at</span><time dateTime={event.created_at}>{event.created_at}</time></div>
      <div className="ti-metadata-value"><span>Event id</span><code>{event.id}</code></div>
    </> : <p className="ti-metadata-note">Select a visible event to inspect its recorded metadata.</p>}</div>
    <div className="ti-metadata-section"><h3 className="ti-label">Run context</h3><ExecutionBadge state={state} /><div className="ti-metadata-value"><span>Agent</span><strong>{run.agent}</strong></div><div className="ti-metadata-value"><span>Scenario</span><strong>{formatScenario(run.scenario)}</strong></div><div className="ti-metadata-value"><span>Project id</span><code>{run.project_id}</code></div><ConfigRow label="Cancellation requested" value={run.cancel_requested ? 'Yes' : 'No'} /></div>
    <details className="ti-run-timestamps" open><summary>Run timestamps</summary><div className="ti-metadata-value"><span>Created</span><time dateTime={run.created_at}>{run.created_at}</time></div><div className="ti-metadata-value"><span>Started</span>{run.started_at ? <time dateTime={run.started_at}>{run.started_at}</time> : <span>Not started</span>}</div><div className="ti-metadata-value"><span>Completed</span>{run.completed_at ? <time dateTime={run.completed_at}>{run.completed_at}</time> : <span>{isTerminal(run.state) ? 'Not recorded' : 'Not completed'}</span>}</div></details>
    {run.error_message && <div className="ti-run-error"><Icon name="warning" size={13} /><span>{run.error_message}</span></div>}
  </aside>
}

function MissingReportState({ run, state }: { run: ApiRun; state: ExecutionState }) {
  const terminal = isTerminal(run.state)
  const hasError = Boolean(run.error_message)
  return <section className={`panel report-state-panel ${terminal || hasError ? 'report-state-error' : 'report-state-pending'}`} role={terminal || hasError ? 'alert' : undefined}><div className="report-state-icon"><Icon name={terminal || hasError ? 'warning' : 'clock'} size={18} /></div><div><span className="section-kicker">{terminal ? 'Missing terminal report' : 'Report availability'}</span><h2>{terminal ? 'No persisted report was returned' : 'Report not available yet'}</h2><p>{run.error_message ?? (terminal ? `The run is ${stateLabel(state)}, but the API did not include report data. Inspect the durable events and server error before treating this as a pass or fail.` : 'The worker has not produced a terminal report. Durable events in the Trace tab remain the source of truth while execution is in progress.')}</p></div></section>
}

function PersistedReportSummary({ report }: { report: ApiReport }) {
  const passed = report.evaluation.passed
  return <section className="ti-report-result"><div><span className="ti-label">Terminal report · report.evaluation</span><h2>Persisted evaluation result</h2></div><div className={`ti-result-badge ${passed ? 'ti-result-pass' : 'ti-result-fail'}`}><Icon name={passed ? 'check' : 'warning'} size={16} /><strong>{passed ? 'Passed' : 'Failed'}</strong><span>{report.evaluation.invariants.filter((item) => item.passed).length}/{report.evaluation.invariants.length} invariants passed</span></div></section>
}

function ReportSectionContent({ run, section, state }: { run: ApiRun; section: Exclude<ReportSection, 'trace'>; state: ExecutionState }) {
  if (!run.report) return <MissingReportState run={run} state={state} />
  if (section === 'ledger') return <ReportLedger report={run.report} />
  if (section === 'findings') return <ReportFindings findings={run.report.evaluation.findings} />
  return <><PersistedReportSummary report={run.report} /><ApiReportEvaluation report={run.report} /></>
}

function ApiReportEvaluation({ report }: { report: ApiReport }) {
  const metrics: Array<[keyof ApiReport['metrics'], string]> = [
    ['payment_attempts', 'Payment attempts'], ['retries', 'Retries'], ['successful_payments', 'Successful payments'],
    ['timeouts', 'Timeouts'], ['malformed_responses', 'Malformed responses'], ['malformed_tool_responses', 'Malformed tool responses'], ['temporary_failures', 'Temporary failures'],
    ['unrecoverable_failures', 'Unrecoverable failures'], ['reconciliations', 'Reconciliations'], ['ledger_charges', 'Ledger charges'],
    ['duplicate_charges', 'Duplicate charges'], ['fulfilled_orders', 'Fulfilled orders'], ['cancelled_orders', 'Cancelled orders'],
  ]
  return <>
    <section className="panel report-metrics-panel"><div className="panel-heading"><div><span className="section-kicker">Result metrics</span><h2>Observed execution counters</h2></div><span className="muted-label">report.metrics</span></div><div className="execution-metrics-grid">{metrics.map(([key, label]) => <ReportMetric key={key} label={label} value={report.metrics[key]} />)}</div></section>
    <div className="ti-evaluation-grid">
      <section className="panel evaluators-panel"><div className="panel-heading"><div><span className="section-kicker">Independent checks</span><h2>Evaluator breakdown</h2></div><span className="muted-label">{report.evaluation.invariants.length} invariants</span></div><div className="evaluator-list">{report.evaluation.invariants.length ? report.evaluation.invariants.map((invariant) => <ApiInvariantRow invariant={invariant} key={invariant.name} />) : <div className="empty-panel">No invariant results recorded.</div>}</div></section>
      <section className="panel config-panel"><div className="panel-heading"><div><span className="section-kicker">Execution context</span><h2>Persisted configuration</h2></div></div><div className="config-list"><ConfigRow label="Agent" value={report.agent_name} /><ConfigRow label="Scenario" value={formatScenario(report.scenario)} /><ConfigRow label="Order" value={report.order.order_id} /><ConfigRow label="Final state" value={report.order.status} /></div></section>
    </div>
  </>
}

function PersistedTrace({ report }: { report: ApiReport }) {
  return <details className="ti-persisted-trace"><summary><Icon name="code" size={14} /><strong>Terminal report trace</strong><span className="ti-count">{report.trace.length}</span><span className="ti-report-source">report.trace · recorded indices & ticks</span><Icon name="chevron-down" size={13} /></summary><div className="ti-report-trace-list">{report.trace.length ? report.trace.map((event) => <div className="ti-report-trace-row" key={`${event.index}-${event.event_type}`}><span className="ti-trace-index">#{event.index}<small>tick {event.tick}</small></span><span><strong>{event.event_type}</strong><small>order {event.order_id}</small><code>{formatAttributes(event.attributes)}</code></span></div>) : <EmptyPanel description="No trace events recorded in the report." />}</div></details>
}

function ReportLedger({ report }: { report: ApiReport }) {
  return <><div className="ti-report-result"><div><span className="ti-label">Persisted evidence · report.ledger</span><h2>Ledger entries</h2></div><span className="ti-count">{report.ledger.entries.length} entries</span></div><div className="ti-ledger-facts"><ConfigRow label="Total charged (report.ledger.total_charged)" value={String(report.ledger.total_charged)} /><ConfigRow label="Order amount" value={`${report.order.amount} ${report.order.currency}`} /><ConfigRow label="Order" value={report.order.order_id} /><ConfigRow label="Final state" value={report.order.status} /><ConfigRow label="Attempts" value={String(report.order.attempts)} /><ConfigRow label="Payment id" value={report.order.payment_id ?? 'Not recorded'} /><ConfigRow label="Idempotency key" value={report.order.idempotency_key} /></div>{report.ledger.entries.length ? <div className="ti-ledger-list">{report.ledger.entries.map((entry) => <article className="ti-ledger-entry" key={entry.entry_id}><div className="ti-ledger-entry-heading"><span className="ti-category-marker ti-category-payment"><Icon name={entry.entry_type === 'charge' ? 'database' : 'arrow-right'} size={14} /></span><div><span className="ti-label">{entry.entry_type}</span><h3>{entry.entry_id}</h3></div><strong>{entry.amount} {entry.currency}</strong></div><div className="ti-ledger-entry-facts"><ConfigRow label="Order" value={entry.order_id} /><ConfigRow label="Payment" value={entry.payment_id} /><ConfigRow label="Idempotency key" value={entry.idempotency_key} /></div></article>)}</div> : <EmptyPanel description="No ledger entries recorded." />}</>
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
  const entries = Object.entries(attributes)
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
