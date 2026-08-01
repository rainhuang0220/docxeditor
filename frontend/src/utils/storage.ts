const STORAGE_KEY = 'ai-doc-ide-document'
const VERSIONS_KEY = 'ai-doc-ide-versions'
const AUTO_SAVE_INTERVAL = 5000

export function saveDocument(html: string) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      html,
      savedAt: new Date().toISOString(),
    }))
  } catch (e) {
    console.warn('[DocxEditor] Failed to save document to localStorage:', e)
  }
}

export function loadDocument(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw)
    return data.html || null
  } catch {
    return null
  }
}

export function clearDocument() {
  localStorage.removeItem(STORAGE_KEY)
}

export function setupAutoSave(getHtml: () => string): () => void {
  const interval = setInterval(() => {
    const html = getHtml()
    if (html) saveDocument(html)
  }, AUTO_SAVE_INTERVAL)

  return () => clearInterval(interval)
}

export interface StoredVersion {
  id: string
  timestamp: string
  description: string
  content: string
}

export function saveVersions(versions: StoredVersion[]) {
  try {
    // Keep max 20 versions to avoid localStorage limits
    const trimmed = versions.slice(0, 20)
    localStorage.setItem(VERSIONS_KEY, JSON.stringify(trimmed))
  } catch {
    // Storage full — drop oldest versions
    try {
      localStorage.setItem(VERSIONS_KEY, JSON.stringify(versions.slice(0, 5)))
    } catch (e) {
      console.warn('[DocxEditor] Failed to save versions:', e)
    }
  }
}

export function loadVersions(): StoredVersion[] {
  try {
    const raw = localStorage.getItem(VERSIONS_KEY)
    if (!raw) return []
    return JSON.parse(raw)
  } catch {
    return []
  }
}
