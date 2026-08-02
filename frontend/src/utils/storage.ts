const STORAGE_KEY = 'ai-doc-ide-document'
const VERSIONS_KEY = 'ai-doc-ide-versions'
const TITLE_KEY = 'ai-doc-ide-title'
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
