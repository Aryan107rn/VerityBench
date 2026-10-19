import { useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from './Icon'

export type WorkspaceCommand = { id: string; label: string; detail: string; icon: IconName; run: () => void }

export function CommandPalette({ commands, onClose }: { commands: WorkspaceCommand[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const filtered = commands.filter((item) => `${item.label} ${item.detail}`.toLowerCase().includes(query.toLowerCase()))
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    input.current?.focus()
    return () => previousFocus?.focus()
  }, [])
  useEffect(() => {
    const item = filtered[selected]
    if (item) dialog.current?.querySelector<HTMLElement>(`[id="workspace-command-${CSS.escape(item.id)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected, query])
  return <div className="command-palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }} role="presentation">
    <div aria-label="Search workspace" aria-modal="true" className="command-palette" onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
      if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((current) => Math.min(current + 1, filtered.length - 1)) }
      if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((current) => Math.max(0, current - 1)) }
      if (event.key === 'Tab') {
        const nodes = dialog.current?.querySelectorAll<HTMLElement>('input, button')
        const first = nodes?.[0]
        const last = nodes?.[nodes.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }} ref={dialog} role="dialog">
      <div className="command-palette-search"><Icon name="search" size={19} /><input aria-activedescendant={filtered[selected] ? `workspace-command-${filtered[selected].id}` : undefined} aria-autocomplete="list" aria-controls="workspace-command-results" aria-expanded="true" aria-label="Search pages and runs" onChange={(event) => { setQuery(event.target.value); setSelected(0) }} onKeyDown={(event) => { if (event.key === 'Enter' && filtered[selected]) { event.preventDefault(); filtered[selected].run(); onClose() } }} placeholder="Search pages, runs, or actions…" ref={input} role="combobox" value={query} /><button aria-label="Close search" onClick={onClose} type="button"><kbd>Esc</kbd></button></div>
      <div className="command-palette-label">Navigate your workspace</div>
      <div className="command-palette-results" id="workspace-command-results" role="listbox" aria-label="Workspace commands">{filtered.length ? filtered.map((command, index) => <div aria-selected={selected === index} className={`command-palette-option ${selected === index ? 'is-selected' : ''}`} id={`workspace-command-${command.id}`} key={command.id} onMouseMove={() => setSelected(index)} role="option"><button onClick={() => { command.run(); onClose() }} tabIndex={-1} type="button"><Icon name={command.icon} size={16} /><span><strong>{command.label}</strong><small>{command.detail}</small></span><Icon name="arrow-right" size={14} /></button></div>) : <div className="empty-panel">No pages or loaded runs match your search.</div>}</div>
      <div className="command-palette-footer"><span><kbd>↑</kbd><kbd>↓</kbd> to navigate</span><span><kbd>↵</kbd> to open</span><span>VerityBench</span></div>
    </div>
  </div>
}
