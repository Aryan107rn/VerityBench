import { useState, type FormEvent } from 'react'
import { Icon } from './Icon'
import type { ApiAgent } from '../lib/api'

const offlineScenarioIds = ['normal', 'timeout_after_success', 'malformed_response', 'malformed_tool_response', 'temporary_failure', 'transient_failure', 'rate_limited', 'unrecoverable_failure', 'retry_exhaustion', 'tool_exception', 'duplicate_operation', 'conflicting_tool_output', 'malicious_tool_output']

const offlineAgents: ApiAgent[] = [
  {
    key: 'safe',
    name: 'safe-sample-agent',
    description: 'Reconciles uncertain payments before fulfillment.',
    source: 'repository',
    runnable: true,
    supported_scenarios: offlineScenarioIds,
  },
  {
    key: 'defective',
    name: 'defective-sample-agent',
    description: 'Demonstrates duplicate-payment behavior for evaluator testing.',
    source: 'repository',
    runnable: true,
    supported_scenarios: offlineScenarioIds,
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
  onImportGithub: (name: string, version: string, repositoryUrl: string, ref: string, entrypoint: string) => Promise<void>
  registrationBusy: boolean
  onRetry: () => void
}

export function AgentsPage({ agents, apiData, error, loading, onBrowseRuns, onOpenCli, onRegister, onImportGithub, registrationBusy, onRetry }: AgentsPageProps) {
  const [formOpen, setFormOpen] = useState(false)
  const [githubFormOpen, setGithubFormOpen] = useState(false)
  const [name, setName] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [source, setSource] = useState('')
  const [repositoryUrl, setRepositoryUrl] = useState('')
  const [ref, setRef] = useState('main')
  const [entrypoint, setEntrypoint] = useState('agent.py')
  const [formError, setFormError] = useState('')
  const [githubFormError, setGithubFormError] = useState('')
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
  const submitGithub = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setGithubFormError('')
    try {
      await onImportGithub(name, version, repositoryUrl, ref, entrypoint)
      setName('')
      setVersion('1.0.0')
      setRepositoryUrl('')
      setRef('main')
      setEntrypoint('agent.py')
      setGithubFormOpen(false)
    } catch (importError: unknown) {
      setGithubFormError(importError instanceof Error ? importError.message : 'Could not import the GitHub agent.')
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
         <div className="page-intro-actions"><button className="button button-secondary" disabled={!apiData} onClick={() => setFormOpen((current) => !current)} type="button"><Icon name="file-plus" size={14} /> {formOpen ? 'Close registration' : 'Register source'}</button><button className="button button-secondary" disabled={!apiData} onClick={() => setGithubFormOpen((current) => !current)} type="button"><Icon name="download" size={14} /> {githubFormOpen ? 'Close GitHub import' : 'Import GitHub agent'}</button><button className="button button-primary" onClick={onBrowseRuns} type="button"><Icon name="play" size={14} /> Browse runs</button></div>
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
       {githubFormOpen && apiData && <form className="panel agent-registration-form" onSubmit={(event) => void submitGithub(event)}><div><span className="section-kicker">Public GitHub import</span><h2>Import a supported Python entrypoint</h2><p>Only public github.com repositories are accepted. The API stores the fetched source and the isolated worker executes it; the API never imports or runs repository code.</p></div><label>Name<input maxLength={128} onChange={(event) => setName(event.target.value)} required value={name} /></label><label>Version<input maxLength={64} onChange={(event) => setVersion(event.target.value)} required value={version} /></label><label>Repository URL<input onChange={(event) => setRepositoryUrl(event.target.value)} placeholder="https://github.com/owner/repository" required value={repositoryUrl} /></label><label>Git ref<input maxLength={200} onChange={(event) => setRef(event.target.value)} required value={ref} /></label><label>Entrypoint<input maxLength={200} onChange={(event) => setEntrypoint(event.target.value)} required value={entrypoint} /></label>{githubFormError && <p className="auth-error" role="alert">{githubFormError}</p>}<div className="form-actions"><button className="button button-primary" disabled={registrationBusy} type="submit">{registrationBusy ? 'Importing…' : 'Import and store artifact'}</button><button className="button button-quiet" onClick={() => setGithubFormOpen(false)} type="button">Cancel</button></div></form>}
       {loading ? <div className="detail-loading" role="status">Loading agents from the selected project…</div> : (
        <section aria-label="Available agents" className="agent-grid">
          {visibleAgents.map((agent) => <AgentCard agent={agent} apiData={apiData} key={agent.key} />)}
        </section>
      )}

      <section className="panel cli-agent-callout">
         <span className="agent-callout-icon"><Icon name="shield" size={18} /></span>
        <div>
          <span className="section-kicker">CLI-only integration</span>
           <h2>Source execution stays worker-only</h2>
           <p>Pasted and public GitHub modules are stored as immutable artifacts. The API never imports them; an explicitly configured isolated worker must execute remote runs.</p>
          <button className="text-button" onClick={onOpenCli} type="button">Open CLI guide <Icon name="arrow-right" size={15} /></button>
        </div>
         <span className="unsupported-pill">Worker required</span>
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
