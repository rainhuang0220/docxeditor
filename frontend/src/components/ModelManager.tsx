import { useState, useEffect } from 'react'
import { X, Plus, Trash2, Check, AlertCircle, Cpu } from 'lucide-react'
import { useEditorContext } from '../context/EditorContext'
import type { ModelProfile, ModelProvider } from '../utils/storage'
import {
  credentialStatusLine,
  deleteCredential,
  getCredentialStatus,
  putCredential,
  testStoredCredential,
  type CredentialStatus,
} from '../utils/credentials'
import { draftFromStatus, reduceCredentialDraft } from '../utils/credentialEditor'
import { commitModelDeletion, planProviderCredentialWrite, profileHasRetainedSecret } from '../utils/modelCredentialDeletion'
import { UNBOUND_CREDENTIAL_WARNING, confirmUnscopedRecovery, discardEarlierCredential } from '../utils/confirmUnscopedRecovery'

const DEFAULT_MODELS: Record<ModelProvider, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-20250514',
}

function makeId() {
  return 'model-' + crypto.randomUUID().slice(0, 8)
}

interface EditableProfile {
  id: string
  label: string
  provider: ModelProvider
  model: string
  baseUrl: string
}

function emptyProfile(): EditableProfile {
  return {
    id: makeId(),
    label: 'New model',
    provider: 'openai',
    model: '',
    baseUrl: '',
  }
}

export function ModelManager() {
  const { models, activeModelId, setActiveModelId, upsertModel, deleteModel, releaseRetainedLegacy, credentialWarning, reviewPending } = useEditorContext()
  const [isOpen, setIsOpen] = useState(false)
  const [editing, setEditing] = useState<EditableProfile | null>(null)
  const [draftKey, setDraftKey] = useState('')
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error' | 'testing' | 'valid' | 'invalid'>('idle')
  const [credential, setCredential] = useState<CredentialStatus | null>(null)
  const [credentialDown, setCredentialDown] = useState(false)
  const [listStatus, setListStatus] = useState<Record<string, CredentialStatus | null>>({})
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null)
  const [originalProvider, setOriginalProvider] = useState<ModelProvider>('openai')

  const refreshList = async (current = models) => {
    const entries = await Promise.all(current.map(async model => {
      try {
        return [model.id, await getCredentialStatus(model.id, model.provider)] as const
      } catch {
        return [model.id, null] as const
      }
    }))
    setListStatus(Object.fromEntries(entries))
  }

  useEffect(() => {
    const open = () => setIsOpen(true)
    window.addEventListener('open-model-manager', open)
    return () => window.removeEventListener('open-model-manager', open)
  }, [])

  useEffect(() => {
    if (!isOpen) return
    void refreshList()
  }, [isOpen, models])

  const loadEditorStatus = async (profile: EditableProfile) => {
    setDraftKey(draftFromStatus(null))
    try {
      const next = await getCredentialStatus(profile.id, profile.provider)
      setCredential(next)
      setCredentialDown(false)
      setDraftKey(draftFromStatus(next))
    } catch {
      setCredential(null)
      setCredentialDown(true)
    }
  }

  const startNew = () => {
    const profile = emptyProfile()
    setEditing(profile)
    setOriginalProvider(profile.provider)
    setStatus('idle')
    setCredential(null)
    setCredentialDown(false)
    setDraftKey(reduceCredentialDraft(draftKey, { type: 'open' }))
  }

  const startEdit = (model: ModelProfile) => {
    const profile: EditableProfile = {
      id: model.id,
      label: model.label,
      provider: model.provider,
      model: model.model,
      baseUrl: model.baseUrl,
    }
    setEditing(profile)
    setOriginalProvider(model.provider)
    setStatus('idle')
    setDraftKey(reduceCredentialDraft(draftKey, { type: 'open' }))
    void loadEditorStatus(profile)
  }

  const closeEditor = () => {
    setDraftKey(reduceCredentialDraft(draftKey, { type: 'close' }))
    setEditing(null)
    setStatus('idle')
    setCredential(null)
    setCredentialDown(false)
  }

  const handleSave = async () => {
    if (!editing) return
    setStatus('saving')
    const profile: ModelProfile = {
      id: editing.id,
      label: editing.label.trim() || `${editing.provider} ${editing.model || 'model'}`,
      provider: editing.provider,
      model: editing.model.trim(),
      baseUrl: editing.baseUrl.trim(),
    }
    const write = planProviderCredentialWrite({
      previousProvider: originalProvider,
      nextProvider: profile.provider,
      typedKey: draftKey,
    })
    try {
      if (write.putApiKey) {
        const saved = await putCredential(profile.id, profile.provider, write.putApiKey)
        setCredential(saved)
        setCredentialDown(false)
        setDraftKey(reduceCredentialDraft(draftKey, { type: 'save-success' }))
        setOriginalProvider(profile.provider)
      }
      upsertModel(profile)
      setStatus('saved')
      await refreshList(models.some(model => model.id === profile.id) ? models.map(model => model.id === profile.id ? profile : model) : [...models, profile])
    } catch {
      setStatus('error')
      setCredentialDown(true)
    }
  }

  const handleTest = async () => {
    if (!editing) return
    setStatus('testing')
    try {
      if (draftKey.trim()) {
        const saved = await putCredential(editing.id, editing.provider, draftKey.trim())
        setCredential(saved)
        setDraftKey(reduceCredentialDraft(draftKey, { type: 'save-success' }))
        upsertModel({
          id: editing.id,
          label: editing.label.trim() || 'Model',
          provider: editing.provider,
          model: editing.model.trim(),
          baseUrl: editing.baseUrl.trim(),
        })
      }
      const result = await testStoredCredential(editing.id, editing.provider, editing.model.trim(), editing.baseUrl.trim())
      setStatus(result.ok ? 'valid' : 'invalid')
      if (!result.ok && result.error) setCredentialDown(false)
    } catch {
      setStatus('invalid')
    }
  }

  const handleDelete = async (id: string, discardRetainedLegacy: boolean) => {
    const model = models.find(item => item.id === id)
    if (!model) return
    if (reviewPending && id === activeModelId) {
      deleteModel(id)
      return
    }
    if (discardRetainedLegacy && !window.confirm('Discard the saved API key and delete this model?')) return
    const result = await commitModelDeletion({
      id,
      provider: model.provider,
      models,
      discardRetainedLegacy,
      deleteRemote: deleteCredential,
    })
    if (!result.removed) {
      setDeleteError(result.message)
      return
    }
    releaseRetainedLegacy(id)
    deleteModel(id)
    setDeleteError(null)
  }

  const handleRecover = async (model: ModelProfile) => {
    const agreed = window.confirm(
      `Bind the earlier credential to ${model.provider}? This app cannot tell which provider it originally used.`,
    )
    if (!agreed) return
    const result = await confirmUnscopedRecovery({
      profileId: model.id,
      provider: model.provider,
      confirmed: true,
    })
    setRecoveryMessage(result.ok ? null : result.message)
    if (result.ok && result.status) {
      setListStatus(current => ({ ...current, [model.id]: result.status }))
      void refreshList()
    }
  }

  const handleDiscardEarlier = async (model: ModelProfile) => {
    const agreed = window.confirm('Discard the earlier unconfirmed credential? The saved key for this provider is not removed.')
    if (!agreed) return
    let discarded = false
    try {
      discarded = await discardEarlierCredential(model.id)
    } catch {
      discarded = false
    }
    if (!discarded) {
      setRecoveryMessage('Could not discard the earlier credential. It was kept.')
      return
    }
    setRecoveryMessage(null)
    void refreshList()
  }

  const editorLine = credentialStatusLine(credential, credentialDown)

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
          <div className="dialog-backdrop" onClick={() => { setIsOpen(false); closeEditor() }} />
          <div className="dialog-panel w-[520px] max-w-[92vw] p-6">
            <div className="flex items-center justify-between mb-5">
              <h3 className="dialog-title">AI Models</h3>
              <button onClick={() => { setIsOpen(false); closeEditor() }} className="dialog-close">
                <X size={15} />
              </button>
            </div>

            {credentialWarning && (
              <p className="mb-4 text-[12.5px] text-[var(--color-danger)] leading-relaxed">{credentialWarning}</p>
            )}
            {deleteError && (
              <p className="mb-4 text-[12.5px] text-[var(--color-danger)] leading-relaxed">{deleteError}</p>
            )}
            {recoveryMessage && (
              <p className="mb-4 text-[12.5px] text-[var(--color-danger)] leading-relaxed">{recoveryMessage}</p>
            )}

            {!editing ? (
              <div className="space-y-4">
                <p className="text-[12.5px] text-[var(--color-text-tertiary)] leading-relaxed">
                  Configure model profiles and switch them from the chat panel. API keys stay on the backend.
                </p>

                <div className="space-y-2">
                  {models.map(model => {
                    const active = model.id === activeModelId
                    const row = listStatus[model.id]
                    const line = row === undefined
                      ? ''
                      : credentialStatusLine(row, row === null)
                    return (
                      <div
                        key={model.id}
                        className={`flex items-center gap-3 px-3 py-2.5 border ${active ? 'border-[var(--color-accent-text)] bg-[var(--color-primary-subtle)]' : 'border-[var(--color-border)] bg-[var(--color-surface-secondary)]'} transition-colors`}
                      >
                        <button
                          onClick={() => setActiveModelId(model.id)}
                          className={`w-4 h-4 grid place-items-center border ${active ? 'bg-[var(--color-primary)] border-[var(--color-primary)]' : 'border-[var(--color-border-strong)]'} transition-colors`}
                          aria-label={active ? 'Active model' : 'Activate model'}
                        >
                          {active && <Check size={10} className="text-white" strokeWidth={3} />}
                        </button>
                        <div className="flex-1 min-w-0">
                          <div className="text-[13.5px] font-medium text-[var(--color-text-primary)] tracking-[-0.01em] truncate">{model.label}</div>
                          <div className="font-mono text-[11px] text-[var(--color-text-tertiary)] tracking-[0.04em] mt-0.5 truncate">
                            {model.provider} · {model.model || 'default'}
                            {line ? ` · ${line}` : ''}
                          </div>
                          {row?.unbound_profile_credential && (
                            <p className="text-[12px] text-[var(--color-danger)] mt-1 leading-relaxed">{UNBOUND_CREDENTIAL_WARNING}</p>
                          )}
                        </div>
                        {row?.unbound_profile_credential && (
                          <button
                            onClick={() => void handleRecover(model)}
                            className="text-[11px] font-mono uppercase tracking-[0.06em] text-[var(--color-text-secondary)] px-2 py-1"
                          >
                            Confirm provider
                          </button>
                        )}
                        {row?.unbound_profile_credential && (
                          <button
                            onClick={() => void handleDiscardEarlier(model)}
                            className="text-[11px] font-mono uppercase tracking-[0.06em] text-[var(--color-danger)] px-2 py-1"
                          >
                            Discard earlier credential
                          </button>
                        )}
                        <button
                          onClick={() => startEdit(model)}
                          className="text-[11px] font-mono uppercase tracking-[0.06em] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] px-2 py-1 transition-colors"
                        >
                          Edit
                        </button>
                        {models.length > 1 && (
                          <button
                            onClick={() => void handleDelete(model.id, false)}
                            className="text-[var(--color-text-muted)] hover:text-[var(--color-danger)] p-1 transition-colors"
                            aria-label="Delete model"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                        {models.length > 1 && profileHasRetainedSecret(model.id) && (
                          <button
                            onClick={() => void handleDelete(model.id, true)}
                            className="text-[11px] font-mono uppercase tracking-[0.06em] text-[var(--color-danger)] px-2 py-1"
                          >
                            Discard saved key
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
                    onChange={e => {
                      const provider = e.target.value as ModelProvider
                      const next = { ...editing, provider }
                      setEditing(next)
                      setDraftKey(reduceCredentialDraft(draftKey, { type: 'open' }))
                      setCredential(null)
                      void loadEditorStatus(next)
                    }}
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
                  {credential?.unbound_profile_credential && (
                    <p className="text-[12.5px] text-[var(--color-danger)] leading-relaxed">{UNBOUND_CREDENTIAL_WARNING}</p>
                  )}
                  <label className="field-label">API Key</label>
                  <input
                    type="password"
                    value={draftKey}
                    onChange={e => setDraftKey(reduceCredentialDraft(draftKey, { type: 'type', apiKey: e.target.value }))}
                    placeholder={editing.provider === 'openai' ? 'sk-...' : 'sk-ant-...'}
                    className="field-input"
                    autoComplete="off"
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

                <div className="pt-2 flex items-center justify-between gap-3">
                  <div className="text-[12px] text-[var(--color-text-muted)] min-w-0">
                    {status === 'valid' && <span className="text-[var(--color-success)] inline-flex items-center gap-1"><Check size={12} /> Key works</span>}
                    {status === 'invalid' && <span className="text-[var(--color-danger)] inline-flex items-center gap-1"><AlertCircle size={12} /> Invalid key</span>}
                    {status === 'error' && <span className="text-[var(--color-danger)] inline-flex items-center gap-1"><AlertCircle size={12} /> Failed</span>}
                    {status === 'testing' && <span className="text-[var(--color-accent-text)]">Testing...</span>}
                    {status === 'saving' && <span>Saving...</span>}
                    {(status === 'idle' || status === 'saved') && <span className="truncate">{editorLine}</span>}
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => { setDraftKey(reduceCredentialDraft(draftKey, { type: 'cancel' })); closeEditor() }} className="btn btn-secondary">Cancel</button>
                    <button onClick={() => void handleTest()} disabled={status === 'testing' || status === 'saving'} className="btn btn-secondary">Test</button>
                    <button onClick={() => void handleSave()} disabled={status === 'saving'} className="btn btn-primary">
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
