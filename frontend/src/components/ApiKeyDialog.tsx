import { useState, useEffect } from 'react'
import { Key, X, Check, AlertCircle } from 'lucide-react'
import { apiUrl } from '../utils/api'

export function ApiKeyDialog() {
  const [isOpen, setIsOpen] = useState(false)
  const [provider, setProvider] = useState<'openai' | 'anthropic'>('openai')
  const [apiKey, setApiKey] = useState('')
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error' | 'testing' | 'valid' | 'invalid'>('idle')

  useEffect(() => {
    if (isOpen) {
      fetch(apiUrl('/api/config'))
        .then(res => res.json())
        .then(data => {
          if (data.provider) setProvider(data.provider)
          if (data.key_hint) setApiKey(data.key_hint)
        })
        .catch(() => {})
    }
  }, [isOpen])

  const handleSave = async () => {
    if (!apiKey.trim()) return
    setStatus('saving')
    try {
      const res = await fetch(apiUrl('/api/config'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, api_key: apiKey }),
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
        body: JSON.stringify({ provider, api_key: apiKey }),
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
        className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300"
        title="API Key Settings"
      >
        <Key size={16} />
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-96 p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-100">AI Configuration</h3>
              <button onClick={() => setIsOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                <X size={16} />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Provider</label>
                <select
                  value={provider}
                  onChange={e => setProvider(e.target.value as 'openai' | 'anthropic')}
                  className="w-full h-8 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 rounded px-2"
                >
                  <option value="openai">OpenAI (GPT-4o)</option>
                  <option value="anthropic">Anthropic (Claude)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">API Key</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={e => { setApiKey(e.target.value); setStatus('idle') }}
                  placeholder={provider === 'openai' ? 'sk-...' : 'sk-ant-...'}
                  className="w-full text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 rounded px-3 py-1.5 focus:outline-none focus:border-blue-500"
                  onKeyDown={e => e.key === 'Enter' && handleSave()}
                />
              </div>

              <div className="flex items-center justify-between pt-2">
                <span className="text-xs text-gray-400">
                  {status === 'saved' && <span className="text-green-600 flex items-center gap-1"><Check size={12} /> Saved</span>}
                  {status === 'valid' && <span className="text-green-600 flex items-center gap-1"><Check size={12} /> Key works</span>}
                  {status === 'invalid' && <span className="text-red-500 flex items-center gap-1"><AlertCircle size={12} /> Invalid key</span>}
                  {status === 'error' && <span className="text-red-500">Failed to save</span>}
                  {status === 'testing' && <span className="text-blue-500">Testing...</span>}
                  {status === 'idle' && 'Key is stored in memory only'}
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={handleTest}
                    disabled={!apiKey.trim() || status === 'testing' || status === 'saving'}
                    className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
                  >
                    Test
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={!apiKey.trim() || status === 'saving'}
                    className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                  >
                    {status === 'saving' ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
