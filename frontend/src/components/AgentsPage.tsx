import { Icon } from './Icon'
import type { ApiAgent } from '../lib/api'

const offlineAgents: ApiAgent[] = [
  {
    key: 'safe',
    name: 'safe-sample-agent',
    description: 'Reconciles uncertain payments before fulfillment.',
    source: 'repository',
    runnable: true,
    supported_scenarios: ['normal', 'timeout_after_success', 'malformed_response', 'temporary_failure', 'unrecoverable_failure'],
  },
  {
    key: 'defective',
    name: 'defective-sample-agent',
    description: 'Demonstrates duplicate-payment behavior for evaluator testing.',
    source: 'repository',
    runnable: true,
    supported_scenarios: ['normal', 'timeout_after_success', 'malformed_response', 'temporary_failure', 'unrecoverable_failure'],
  },
]

type AgentsPageProps = {
  agents: ApiAgent[]
  apiData: boolean
  error: string
  loading: boolean
  onBrowseRuns: () => void
  onOpenCli: () => void
  onRetry: () => void
}

export function AgentsPage({ agents, apiData, error, loading, onBrowseRuns, onOpenCli, onRetry }: AgentsPageProps) {
  const visibleAgents = apiData ? agents : offlineAgents
  return (
    <>
      <div className="page-intro">
        <div>
          <span className="eyebrow"><span className="eyebrow-line" />Agent registry</span>
          <h1>Agents</h1>
          <p>See which repository agents the selected project can execute from the web workspace.</p>
        </div>
        <button className="button button-primary" onClick={onBrowseRuns} type="button"><Icon name="play" size={14} /> Browse runs</button>
      </div>

      <div className={`data-notice ${apiData ? 'data-notice-live' : ''}`}>
        <Icon name={apiData ? 'shield' : 'layers'} size={16} />
        <span>
          <strong>{apiData ? 'API registry' : 'Offline fixture registry'}</strong>{' · '}
          {apiData ? 'These entries were returned by the authenticated project API.' : 'These repository-owned entries are a local preview and are not an API response.'}
        </span>
      </div>

      {error && <div className="inline-error" role="alert">{error}<button className="text-button" onClick={onRetry} type="button">Try again</button></div>}
      {loading ? <div className="detail-loading" role="status">Loading agents from the selected project…</div> : (
        <section aria-label="Available agents" className="agent-grid">
          {visibleAgents.map((agent) => <AgentCard agent={agent} apiData={apiData} key={agent.key} />)}
        </section>
      )}

      <section className="panel cli-agent-callout">
        <span className="agent-callout-icon"><Icon name="terminal" size={18} /></span>
        <div>
          <span className="section-kicker">CLI-only integration</span>
          <h2>Custom Python agents are not web-runnable</h2>
          <p>Custom modules can be evaluated by the local CLI worker only. They are intentionally not imported by the API and cannot be started from this page.</p>
          <button className="text-button" onClick={onOpenCli} type="button">Open CLI guide <Icon name="arrow-right" size={15} /></button>
        </div>
        <span className="unsupported-pill">Unsupported in web execution</span>
      </section>
    </>
  )
}

function AgentCard({ agent, apiData }: { agent: ApiAgent; apiData: boolean }) {
  return (
    <article className="panel agent-card">
      <div className="agent-card-top">
        <span className="agent-icon"><Icon name="sparkles" size={18} /></span>
        <span className="agent-source-pill">{apiData ? 'API · repository' : 'Offline fixture'}</span>
      </div>
      <h2>{agent.name}</h2>
      <p>{agent.description}</p>
      <div className="agent-facts">
        <span><strong>{agent.runnable ? 'Runnable' : 'Metadata only'}</strong><small>web capability</small></span>
        <span><strong>{agent.supported_scenarios.length}</strong><small>scenarios</small></span>
      </div>
      <div className="agent-scenarios">
        <span className="section-kicker">Supported scenarios</span>
        <div>{agent.supported_scenarios.map((scenario) => <span className="scenario-pill" key={scenario}>{scenario.replaceAll('_', ' ')}</span>)}</div>
      </div>
    </article>
  )
}
