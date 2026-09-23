/**
 * Returns the base URL for API calls.
 * In development, Vite proxies /api to localhost:8000.
 * In production (Tauri), we need to hit the backend directly.
 */
export function getApiBase(): string {
  // In dev mode (Vite dev server), use relative paths (proxy handles it).
  const env = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env
  if (env?.DEV) return ''
  // In production (Tauri bundle), hit backend directly
  return 'http://127.0.0.1:8000'
}

export function apiUrl(path: string): string {
  return `${getApiBase()}${path}`
}
