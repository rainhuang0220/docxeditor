import { useState, useEffect } from 'react'
import { X, Plus, Trash2, Check, AlertCircle, Cpu } from 'lucide-react'
import { useEditorContext } from '../context/EditorContext'
import { apiUrl } from '../utils/api'
import type { ModelProfile } from '../utils/storage'

const DEFAULT_MODELS: Record<'openai' | 'anthropic', string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-20250514',
}

function makeId() {
  return 'model-' + crypto.randomUUID().slice(0, 8)
}

function maskKey(key: string): string {
  if (!key) return ''
  return key.length > 7 ? key.slice(0, 7) + '…' : '***'
}

interface EditableProfile extends Omit<ModelProfile, 'keyHint'> {
  /** A 7-char hint of the saved key, never overwritten until the user
   *  types a new key. */
  keyHint: string
}

function emptyProfile(): EditableProfile {
  return {
    id: makeId(),
    label: 'New model',
    provider: 'openai',
    model: '',
    baseUrl: '',
    apiKey: '',
    keyHint: '',
  }
}

export function ModelManager() {
  const { models, activeModelId, setActiveModelId, upsertModel, deleteModel } = useEditorContext()
  const [isOpen, setIsOpen] = useState(false)
  const [editing, setEditing] = useState<EditableProfile | null>(null)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  useEffect(() => {
    const open = () => setIsOpen(true)
    window.addEventListener('open-model-manager', open)
    return () => window.removeEventListener('open-model-manager', open)
  }, [])

  const startNew = () => setEditing(emptyProfile())
  const startEdit = (m: ModelProfile) => setEditing({ ...m, keyHint: m.keyHint })

  const handleSave = async () => {
    if (!editing) return
    setStatus('saving')
    // Persist the new key only if the user actually typed one; otherwise
    // preserve the previously-saved hint so the existing key survives.
    const finalKey = editing.apiKey && editing.apiKey !== editing.keyHint ? editing.apiKey : ''
    const finalHint = finalKey ? maskKey(finalKey) : editing.keyHint
    const profile: ModelProfile = {
      id: editing.id,
      label: editing.label.trim() || `${editing.provider} ${editing.model}`,
      provider: editing.provider,
      model: editing.model.trim(),
      baseUrl: editing.baseUrl.trim(),
      apiKey: finalKey,
      keyHint: finalHint,
    }
    upsertModel(profile)
    // If this is the active model, push the new config to the backend so
    // subsequent chats use it immediately.
    if (profile.id === activeModelId) {
      try {
        await fetch(apiUrl('/api/config'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: profile.provider,
            api_key: profile.apiKey,
            model: profile.model,
            base_url: profile.baseUrl,
          }),
        })
      } catch { /* backend may be down — UI state is still saved */ }
    }
    setStatus('saved')
    setTimeout(() => { setStatus('idle'); setEditing(null) }, 600)
  }

  const handleCancel = () => {
    setEditing(null)
    setStatus('idle')
  }

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="tool-btn w-[30px] h-[30px] grid place-items-center text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
        title="Manage AI models"
      >
        <Cpu size={16} />
      </button>

      {isOpen && (
        <>
          <div className="dialog-backdrop" onClick={() => { setIsOpen(false); handleCancel() }} />
          <div className="dialog-panel w-[520px] max-w-[92vw] p-6">
            <div className="flex items-center justify-between mb-5">
              <h3 className="dialog-title">AI Models</h3>
              <button onClick={() => { setIsOpen(false); handleCancel() }} className="dialog-close">
                <X size={15} />
              </button>
            </div>

            {!editing ? (
              <div className="space-y-4">
                <p className="text-[12.5px] text-[var(--color-text-tertiary)] leading-relaxed">
                  Configure multiple model profiles and switch between them from the chat panel. The active model is sent to the backend before each request.
                </p>

                <div className="space-y-2">
                  {models.map(m => {
                    const active = m.id === activeModelId
                    return (
                      <div
                        key={m.id}
                        className={`flex items-center gap-3 px-3 py-2.5 border ${active ? 'border-[var(--color-accent-text)] bg-[var(--color-primary-subtle)]' : 'border-[var(--color-border)] bg-[var(--color-surface-secondary)]'} transition-colors`}
                      >
                        <button
                          onClick={() => setActiveModelId(m.id)}
                          className={`w-4 h-4 grid place-items-center border ${active ? 'bg-[var(--color-primary)] border-[var(--color-primary)]' : 'border-[var(--color-border-strong)]'} transition-colors`}
                          aria-label={active ? 'Active model' : 'Activate model'}
                        >
                          {active && <Check size={10} className="text-white" strokeWidth={3} />}
                        </button>
                        <div className="flex-1 min-w-0">
                          <div className="text-[13.5px] font-medium text-[var(--color-text-primary)] tracking-[-0.01em] truncate">{m.label}</div>
                          <div className="font-mono text-[11px] text-[var(--color-text-tertiary)] tracking-[0.04em] mt-0.5 truncate">
                            {m.provider} · {m.model || 'default'}
                            {m.keyHint && ` · ${m.keyHint}`}
                          </div>
                        </div>
                        <button
                          onClick={() => startEdit(m)}
                          className="text-[11px] font-mono uppercase tracking-[0.06em] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] px-2 py-1 transition-colors"
                        >
                          Edit
                        </button>
                        {models.length > 1 && (
                          <button
                            onClick={() => deleteModel(m.id)}
                            className="text-[var(--color-text-muted)] hover:text-[var(--color-danger)] p-1 transition-colors"
                            aria-label="Delete model"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>

                <button
                  onClick={startNew}
                  className="w-full flex items-center justify-center gap-2 py-2.5 border border-dashed border-[var(--color-border-strong)] text-[12px] font-mono uppercase tracking-[0.06em] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-accent-text)] transition-colors"
                >
                  <Plus size={13} /> Add model
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="field-label">Label</label>
                  <input
                    type="text"
                    value={editing.label}
                    onChange={e => setEditing({ ...editing, label: e.target.value })}
                    placeholder="e.g. Claude Opus (work)"
                    className="field-input"
                  />
                </div>

                <div>
                  <label className="field-label">Provider</label>
                  <select
                    value={editing.provider}
                    onChange={e => setEditing({ ...editing, provider: e.target.value as 'openai' | 'anthropic' })}
                    className="field-select"
                  >
                    <option value="openai">OpenAI (GPT-4o)</option>
                    <option value="anthropic">Anthropic (Claude)</option>
                  </select>
                </div>

                <div>
                  <label className="field-label">
                    Model <span className="text-[var(--color-text-muted)] normal-case tracking-normal font-sans">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={editing.model}
                    onChange={e => setEditing({ ...editing, model: e.target.value })}
                    placeholder={`Default: ${DEFAULT_MODELS[editing.provider]}`}
                    className="field-input"
                  />
                </div>

                <div>
                  <label className="field-label">
                    API Key <span className="text-[var(--color-text-muted)] normal-case tracking-normal font-sans">{editing.keyHint ? `(saved: ${editing.keyHint})` : ''}</span>
                  </label>
                  <input
                    type="password"
                    value={editing.apiKey}
                    onChange={e => setEditing({ ...editing, apiKey: e.target.value })}
                    placeholder={editing.provider === 'openai' ? 'sk-...' : 'sk-ant-...'}
                    className="field-input"
                  />
                </div>

                <div>
                  <label className="field-label">
                    Base URL <span className="text-[var(--color-text-muted)] normal-case tracking-normal font-sans">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={editing.baseUrl}
                    onChange={e => setEditing({ ...editing, baseUrl: e.target.value })}
                    placeholder={editing.provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com'}
                    className="field-input"
                  />
                </div>

                <div className="pt-2 flex items-center justify-between">
                  <div className="text-[12px] text-[var(--color-text-muted)]">
                    {status === 'saved' && <span className="text-[var(--color-success)] inline-flex items-center gap-1"><Check size={12} /> Saved</span>}
                    {status === 'error' && <span className="text-[var(--color-danger)] inline-flex items-center gap-1"><AlertCircle size={12} /> Failed</span>}
                    {status === 'idle' && editing.keyHint && 'Key is preserved unless you type a new one.'}
                  </div>
                  <div className="flex gap-2">
                    <button onClick={handleCancel} className="btn btn-secondary">Cancel</button>
                    <button onClick={handleSave} disabled={status === 'saving'} className="btn btn-primary">
                      {status === 'saving' ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </>
  )
}