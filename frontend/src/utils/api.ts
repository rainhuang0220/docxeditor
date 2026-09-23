/**
 * One transport for browser development and the packaged desktop app.
 * In the desktop app the session token stays in Rust. This module never
 * stores it, and it never puts it in a URL.
 */

const TAURI_REQUEST_LIMIT = 20_000_000

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export function getApiBase(): string {
  const env = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env
  if (env?.DEV) return ''
  return ''
}

export function apiUrl(path: string): string {
  return `${getApiBase()}${path}`
}

type InvokeResult = { status: number; contentType: string; bodyBase64: string }

function bytesToBase64(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text)
}

function base64ToBlob(value: string): Blob {
  const binary = atob(value)
  const buffer = new ArrayBuffer(binary.length)
  const bytes = new Uint8Array(buffer)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([buffer])
}

async function fileFromBody(body: BodyInit | null | undefined): Promise<{ name: string; base64: string } | null> {
  if (!(body instanceof FormData)) return null
  const file = body.get('file')
  if (!(file instanceof File)) return null
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.byteLength > TAURI_REQUEST_LIMIT) throw new Error('The request was rejected.')
  return { name: file.name || 'document.docx', base64: bytesToBase64(bytes) }
}

async function tauriRequest(path: string, init?: RequestInit): Promise<Response> {
  const { invoke } = await import('@tauri-apps/api/core')
  const file = await fileFromBody(init?.body)
  const result = await invoke<InvokeResult>('api_request', {
    method: init?.method || 'GET',
    path,
    body: typeof init?.body === 'string' ? init.body : null,
    contentType: file ? null : 'application/json',
    fileName: file?.name ?? null,
    fileBase64: file?.base64 ?? null,
  })
  return new Response(base64ToBlob(result.bodyBase64 || ''), {
    status: result.status,
    headers: { 'content-type': result.contentType || 'application/octet-stream' },
  })
}

async function tauriStream(path: string, init?: RequestInit): Promise<Response> {
  const { invoke, Channel } = await import('@tauri-apps/api/core')
  const requestId = crypto.randomUUID()
  const channel = new Channel<string>()
  const queue: Uint8Array[] = []
  let waiter: ((chunk: Uint8Array | null) => void) | null = null
  let finished = false
  let status = 503
  let contentType = 'text/event-stream'
  let opened!: () => void
  const ready = new Promise<void>(resolve => { opened = resolve })
  const encoder = new TextEncoder()
  const push = (chunk: Uint8Array | null) => {
    if (waiter) {
      const notify = waiter
      waiter = null
      notify(chunk)
      return
    }
    if (chunk) queue.push(chunk)
  }
  channel.onmessage = (raw) => {
    let message: { kind?: string; status?: number; contentType?: string; data?: string }
    try {
      message = JSON.parse(raw) as typeof message
    } catch {
      return
    }
    if (message.kind === 'status') {
      status = message.status ?? 503
      contentType = message.contentType || contentType
      opened()
      return
    }
    if (message.kind === 'chunk' && message.data) push(encoder.encode(message.data))
    if (message.kind === 'end' || message.kind === 'error') {
      finished = true
      push(null)
    }
  }
  const cancel = () => { void invoke('api_cancel', { requestId }) }
  init?.signal?.addEventListener('abort', cancel, { once: true })
  const pending = invoke('api_stream', {
    requestId,
    path,
    body: typeof init?.body === 'string' ? init.body : '',
    channel,
  }).catch(() => {
    finished = true
    opened()
    push(null)
  })
  await ready
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (queue.length > 0) {
        controller.enqueue(queue.shift()!)
        return
      }
      if (finished) {
        controller.close()
        return
      }
      return new Promise(resolve => {
        waiter = (chunk) => {
          if (chunk) controller.enqueue(chunk)
          else controller.close()
          resolve()
        }
      })
    },
    cancel() {
      cancel()
    },
  })
  void pending
  return new Response(stream, { status, headers: { 'content-type': contentType } })
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!isTauri()) return fetch(apiUrl(path), init)
  if (path.split('?')[0].endsWith('/stream')) return tauriStream(path, init)
  return tauriRequest(path, init)
}

export async function retryBackend(): Promise<void> {
  if (!isTauri()) return
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('backend_retry')
}
