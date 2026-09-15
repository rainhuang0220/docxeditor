const TITLE_KEY = 'ai-doc-ide-title'

export function saveTitle(title: string) {
  try {
    localStorage.setItem(TITLE_KEY, title)
  } catch { /* ignore */ }
}

export function loadTitle(): string {
  try {
    return localStorage.getItem(TITLE_KEY) || 'Untitled Document'
  } catch {
    return 'Untitled Document'
  }
}

const HEADER_KEY = 'ai-doc-ide-header'
const FOOTER_KEY = 'ai-doc-ide-footer'

export function saveHeaderFooter(header: string, footer: string) {
  try {
    localStorage.setItem(HEADER_KEY, header)
    localStorage.setItem(FOOTER_KEY, footer)
  } catch { /* ignore */ }
}

export function loadHeaderFooter(): { header: string; footer: string } {
  try {
    return {
      header: localStorage.getItem(HEADER_KEY) || '',
      footer: localStorage.getItem(FOOTER_KEY) || '',
    }
  } catch {
    return { header: '', footer: '' }
  }
}

/* ─── Model profiles ──────────────────────────────────────────────
 * Users can configure multiple model presets (different providers,
 * models, base URLs, keys). The active profile is synced to the backend
 * before each chat request, so the user can swap models on the fly.
 */

export type ModelProvider = 'openai' | 'anthropic'

export interface ModelProfile {
  id: string
  label: string
  provider: ModelProvider
  model: string
  baseUrl: string
  /** Stored only on the frontend; never sent back to the backend until
   *  the user explicitly activates this profile. */
  apiKey: string
  /** A 7-char masked hint, useful for displaying in the dropdown. */
  keyHint: string
}

const MODELS_KEY = 'ai-doc-ide-models'
const ACTIVE_MODEL_KEY = 'ai-doc-ide-active-model'

export const DEFAULT_MODEL_PROFILES: ModelProfile[] = [
  {
    id: 'default-gpt-4o',
    label: 'GPT-4o',
    provider: 'openai',
    model: 'gpt-4o',
    baseUrl: '',
    apiKey: '',
    keyHint: '',
  },
  {
    id: 'default-claude-sonnet',
    label: 'Claude Sonnet 4',
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    baseUrl: '',
    apiKey: '',
    keyHint: '',
  },
]

export function loadModelProfiles(): ModelProfile[] {
  try {
    const raw = localStorage.getItem(MODELS_KEY)
    if (!raw) return DEFAULT_MODEL_PROFILES
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_MODEL_PROFILES
    return parsed
  } catch {
    return DEFAULT_MODEL_PROFILES
  }
}

export function saveModelProfiles(profiles: ModelProfile[]) {
  try {
    localStorage.setItem(MODELS_KEY, JSON.stringify(profiles))
  } catch (e) {
    console.warn('[DocxEditor] Failed to save model profiles:', e)
  }
}

export function loadActiveModelId(): string {
  try {
    return localStorage.getItem(ACTIVE_MODEL_KEY) || DEFAULT_MODEL_PROFILES[0].id
  } catch {
    return DEFAULT_MODEL_PROFILES[0].id
  }
}

export function saveActiveModelId(id: string) {
  try {
    localStorage.setItem(ACTIVE_MODEL_KEY, id)
  } catch { /* ignore */ }
}

/* ─── Conversation threads ─────────────────────────────────────────
 * Multiple chat threads persist across reloads. The most recent 10 are
 * retained; older threads are dropped.
 */

export interface StoredThread {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  /** Backend key hint + provider used for this thread, so we can show the
   *  user which model produced it in the history list. */
  provider: ModelProvider
  model: string
  messages: { id: string; role: 'user' | 'assistant'; content: string }[]
}

const THREADS_KEY = 'ai-doc-ide-threads'
const ACTIVE_THREAD_KEY = 'ai-doc-ide-active-thread'

export const MAX_THREADS = 10
export const MIN_THREADS_RETAINED = 5

export function loadThreads(): StoredThread[] {
  try {
    const raw = localStorage.getItem(THREADS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
  } catch {
    return []
  }
}

export function saveThreads(threads: StoredThread[]) {
  try {
    // Keep at least 5, but cap at MAX_THREADS to avoid localStorage bloat.
    const keep = Math.max(MIN_THREADS_RETAINED, MAX_THREADS)
    const trimmed = threads.slice(0, keep)
    localStorage.setItem(THREADS_KEY, JSON.stringify(trimmed))
  } catch (e) {
    console.warn('[DocxEditor] Failed to save threads:', e)
  }
}

export function loadActiveThreadId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_THREAD_KEY)
  } catch {
    return null
  }
}

export function saveActiveThreadId(id: string | null) {
  try {
    if (id) localStorage.setItem(ACTIVE_THREAD_KEY, id)
    else localStorage.removeItem(ACTIVE_THREAD_KEY)
  } catch { /* ignore */ }
}
