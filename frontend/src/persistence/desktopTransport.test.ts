import assert from 'node:assert/strict'
import { test } from 'node:test'
import { desktopRequestAllowed, openDesktopStream } from '../utils/api.ts'

test('an already aborted signal does not start a desktop stream', async () => {
  const controller = new AbortController()
  controller.abort()
  const calls: string[] = []
  await assert.rejects(
    () => openDesktopStream('/api/chat/stream', { method: 'POST', body: '{}', signal: controller.signal }, (async (command: string) => {
      calls.push(command)
      return undefined
    }) as never, () => ({ onmessage: null })),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  )
  assert.deepEqual(calls, [])
  assert.equal(desktopRequestAllowed(controller.signal), false)
})

test('abort during setup does not invoke the stream', async () => {
  const controller = new AbortController()
  const calls: string[] = []
  await assert.rejects(
    () => openDesktopStream('/api/chat/stream', { method: 'POST', body: '{}', signal: controller.signal }, (async (command: string) => {
      calls.push(command)
      return undefined
    }) as never, () => {
      controller.abort()
      return { onmessage: null }
    }),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  )
  assert.deepEqual(calls, [])
})

test('abort after the stream is invoked cancels that request id', async () => {
  const controller = new AbortController()
  const calls: { command: string; requestId?: string }[] = []
  const pending = openDesktopStream('/api/chat/stream', { method: 'POST', body: '{}', signal: controller.signal }, (async (command: string, args: Record<string, unknown>) => {
    calls.push({ command, requestId: String(args.requestId || '') })
    if (command === 'api_stream') {
      controller.abort()
      return new Promise(() => undefined)
    }
    return undefined
  }) as never, () => ({ onmessage: null }))
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === 'AbortError')
  assert.equal(calls.some(call => call.command === 'api_cancel' && call.requestId === calls[0]?.requestId), true)
  assert.equal(calls.filter(call => call.command === 'api_stream').length, 1)
})

test('an already aborted signal does not start a non-stream request', () => {
  const controller = new AbortController()
  controller.abort()
  assert.equal(desktopRequestAllowed(controller.signal), false)
})
