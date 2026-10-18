import { useState, type FormEvent } from 'react'
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
  onRegister: (name: string, version: string, source: string) => Promise<void>
  registrationBusy: boolean
  onRetry: () => void
}

export function AgentsPage({ agents, apiData, error, loading, onBrowseRuns, onOpenCli, onRegister, registrationBusy, onRetry }: AgentsPageProps) {
  const [formOpen, setFormOpen] = useState(false)
  const [name, setName] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [source, setSource] = useState('')
  const [formError, setFormError] = useState('')
  const visibleAgents = apiData ? agents : offlineAgents
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormError('')
    try {
      await onRegister(name, version, source)
      setName('')
      setVersion('1.0.0')
      setSource('')
      setFormOpen(false)
    } catch (registrationError: unknown) {
      setFormError(registrationError instanceof Error ? registrationError.message : 'Could not register the agent.')
    }
  }
  return (
    <>
      <div className="page-intro">
        <div>
          <span className="eyebrow"><span className="eyebrow-line" />Agent registry</span>
          <h1>Agents</h1>
          <p>See which repository agents the selected project can execute from the web workspace.</p>
        </div>
        <div className="page-intro-actions"><button className="button button-secondary" disabled={!apiData} onClick={() => setFormOpen((current) => !current)} type="button"><Icon name="file-plus" size={14} /> {formOpen ? 'Close registration' : 'Register remote agent'}</button><button className="button button-primary" onClick={onBrowseRuns} type="button"><Icon name="play" size={14} /> Browse runs</button></div>
      </div>

      <div className={`data-notice ${apiData ? 'data-notice-live' : ''}`}>
        <Icon name={apiData ? 'shield' : 'layers'} size={16} />
        <span>
          <strong>{apiData ? 'API registry' : 'Offline fixture registry'}</strong>{' · '}
          {apiData ? 'These entries were returned by the authenticated project API.' : 'These repository-owned entries are a local preview and are not an API response.'}
        </span>
      </div>

      {error && <div className="inline-error" role="alert">{error}<button className="text-button" onClick={onRetry} type="button">Try again</button></div>}
      {formOpen && apiData && <form className="panel agent-registration-form" onSubmit={(event) => void submit(event)}><div><span className="section-kicker">Explicit remote integration</span><h2>Register a compatible Python agent</h2><p>Source is stored as an artifact and never imported by FastAPI. A separately configured Docker worker must be running before its remote runs can complete.</p></div><label>Name<input maxLength={128} onChange={(event) => setName(event.target.value)} required value={name} /></label><label>Version<input maxLength={64} onChange={(event) => setVersion(event.target.value)} required value={version} /></label><label className="agent-source-field">Contract source<textarea maxLength={256000} onChange={(event) => setSource(event.target.value)} placeholder="Paste a version-1 module exporting create_agent()." required rows={10} value={source} /></label>{formError && <p className="auth-error" role="alert">{formError}</p>}<div className="form-actions"><button className="button button-primary" disabled={registrationBusy} type="submit">{registrationBusy ? 'Registering…' : 'Store agent artifact'}</button><button className="button button-quiet" onClick={() => setFormOpen(false)} type="button">Cancel</button></div></form>}
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
         <span className="agent-source-pill">{apiData ? `API · ${agent.source}` : 'Offline fixture'}</span>
      </div>
       <h2>{agent.name}</h2>
       {agent.version && <span className="agent-version">v{agent.version}</span>}
      <p>{agent.description}</p>
       <div className="agent-facts">
         <span><strong>{agent.runnable ? 'Runnable' : 'Disabled'}</strong><small>{agent.source === 'remote' ? 'isolated worker' : 'web capability'}</small></span>
        <span><strong>{agent.supported_scenarios.length}</strong><small>scenarios</small></span>
      </div>
      <div className="agent-scenarios">
        <span className="section-kicker">Supported scenarios</span>
        <div>{agent.supported_scenarios.map((scenario) => <span className="scenario-pill" key={scenario}>{scenario.replaceAll('_', ' ')}</span>)}</div>
      </div>
    </article>
  )
}
