import { useState, useEffect } from 'react'
import { Key, X, Check, AlertCircle } from 'lucide-react'
import { apiUrl } from '../utils/api'

const DEFAULT_MODELS: Record<'openai' | 'anthropic', string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-20250514',
}

export function ApiKeyDialog() {
  const [isOpen, setIsOpen] = useState(false)
  const [provider, setProvider] = useState<'openai' | 'anthropic'>('openai')
  const [apiKey, setApiKey] = useState('')
  const [keyHint, setKeyHint] = useState('')
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error' | 'testing' | 'valid' | 'invalid'>('idle')

  // Allow other components (e.g. the AI panel banner) to open this dialog
  useEffect(() => {
    const open = () => { setIsOpen(true); setStatus('idle') }
    window.addEventListener('open-ai-config', open)
    return () => window.removeEventListener('open-ai-config', open)
  }, [])

  useEffect(() => {
    if (isOpen) {
      fetch(apiUrl('/api/config'))
        .then(res => res.json())
        .then(data => {
          if (data.provider) setProvider(data.provider)
          if (data.key_hint) {
            setApiKey(data.key_hint)
            setKeyHint(data.key_hint)
          }
          if (data.model) setModel(data.model)
          if (data.base_url) setBaseUrl(data.base_url)
        })
        .catch(() => {})
    }
  }, [isOpen])

  const configBody = () => JSON.stringify({
    provider,
    // The dialog shows a masked hint of the saved key; only send the key
    // if the user actually typed a new one, so the hint never overwrites it.
    api_key: apiKey === keyHint ? '' : apiKey,
    model: model.trim(),
    base_url: baseUrl.trim(),
  })

  const handleSave = async () => {
    if (!apiKey.trim()) return
    setStatus('saving')
    try {
      const res = await fetch(apiUrl('/api/config'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: configBody(),
      })
      if (res.ok) {
        setStatus('saved')
        setTimeout(() => setIsOpen(false), 800)
      } else {
        setStatus('error')
      }
    } catch {
      setStatus('error')
    }
  }

  const handleTest = async () => {
    if (!apiKey.trim()) return
    setStatus('testing')
    try {
      // Save first, then test
      await fetch(apiUrl('/api/config'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: configBody(),
      })
      const res = await fetch(apiUrl('/api/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Say "OK" only.', document: '', history: [] }),
      })
      const data = await res.json()
      if (data.reply && !data.reply.startsWith('Error:') && !data.reply.includes('No API key')) {
        setStatus('valid')
      } else {
        setStatus('invalid')
      }
    } catch {
      setStatus('invalid')
    }
  }

  return (
    <>
      <button
        onClick={() => { setIsOpen(true); setStatus('idle') }}
        className="tool-btn w-[30px] h-[30px] grid place-items-center rounded-md text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
        title="AI Model Settings (API Key / Model / Base URL)"
      >
        <Key size={16} />
      </button>

      {isOpen && (
        <>
          <div className="dialog-backdrop" onClick={() => setIsOpen(false)} />
          <div className="dialog-panel w-[420px] max-w-[90vw] p-6">
            <div className="flex items-center justify-between mb-5">
              <h3 className="dialog-title">AI Configuration</h3>
              <button onClick={() => setIsOpen(false)} className="dialog-close">
                <X size={15} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="field-label">Provider</label>
                <select
                  value={provider}
                  onChange={e => setProvider(e.target.value as 'openai' | 'anthropic')}
                  className="field-select"
                >
                  <option value="openai">OpenAI (GPT-4o)</option>
                  <option value="anthropic">Anthropic (Claude)</option>
                </select>
              </div>

              <div>
                <label className="field-label">API Key</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={e => { setApiKey(e.target.value); setStatus('idle') }}
                  placeholder={provider === 'openai' ? 'sk-...' : 'sk-ant-...'}
                  className="field-input"
                  onKeyDown={e => e.key === 'Enter' && handleSave()}
                />
              </div>

              <div>
                <label className="field-label">
                  Model <span className="font-normal text-[var(--color-text-muted)]">(optional)</span>
                </label>
                <input
                  type="text"
                  value={model}
                  onChange={e => { setModel(e.target.value); setStatus('idle') }}
                  placeholder={`Default: ${DEFAULT_MODELS[provider]}`}
                  className="field-input"
                />
              </div>

              <div>
                <label className="field-label">
                  Base URL <span className="font-normal text-[var(--color-text-muted)]">(optional, for proxies / compatible APIs)</span>
                </label>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={e => { setBaseUrl(e.target.value); setStatus('idle') }}
                  placeholder={provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com'}
                  className="field-input"
                />
              </div>

              <div className="pt-2">
                <div className="text-[12px] text-[var(--color-text-muted)] mb-3 truncate">
                  {status === 'saved' && <span className="text-emerald-500 inline-flex items-center gap-1"><Check size={12} /> Saved</span>}
                  {status === 'valid' && <span className="text-emerald-500 inline-flex items-center gap-1"><Check size={12} /> Key works</span>}
                  {status === 'invalid' && <span className="text-red-500 inline-flex items-center gap-1"><AlertCircle size={12} /> Invalid key</span>}
                  {status === 'error' && <span className="text-red-500">Failed to save</span>}
                  {status === 'testing' && <span className="text-[var(--color-primary)]">Testing...</span>}
                  {status === 'idle' && 'Key is stored in memory only'}
                </div>
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={handleTest}
                    disabled={!apiKey.trim() || status === 'testing' || status === 'saving'}
                    className="btn btn-secondary disabled:opacity-40"
                  >
                    Test
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={!apiKey.trim() || status === 'saving'}
                    className="btn btn-primary disabled:opacity-40"
                  >
                    {status === 'saving' ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  )
}
