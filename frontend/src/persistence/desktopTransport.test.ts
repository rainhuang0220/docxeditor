import assert from 'node:assert/strict'
import { test } from 'node:test'
import { desktopRequestAllowed, openDesktopStream } from '../utils/api.ts'

type Call = { command: string; requestId?: string; owner?: string }

function callsOf(invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> | unknown): {
  calls: Call[]
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>
} {
  const calls: Call[] = []
  return {
    calls,
    invoke: async (command, args) => {
      calls.push({
        command,
        requestId: typeof args.requestId === 'string' ? args.requestId : undefined,
        owner: typeof args.owner === 'string' ? args.owner : undefined,
      })
      return invoke(command, args)
    },
  }
}

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

test('abort after reservation does not start the stream', async () => {
  const controller = new AbortController()
  const seen = callsOf(async command => {
    if (command === 'api_stream_reserve') controller.abort()
    return undefined
  })
  await assert.rejects(
    () => openDesktopStream('/api/chat/stream', { method: 'POST', body: '{}', signal: controller.signal }, seen.invoke as never, () => ({ onmessage: null })),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  )
  assert.deepEqual(seen.calls.map(call => call.command), ['api_stream_reserve', 'api_cancel', 'api_stream_release'])
  assert.equal(seen.calls[0]?.requestId, seen.calls[1]?.requestId)
  assert.equal(seen.calls[0]?.owner, seen.calls[1]?.owner)
  assert.equal(seen.calls[0]?.owner, seen.calls[2]?.owner)
  assert.equal(seen.calls.filter(call => call.command === 'api_stream').length, 0)
})

test('abort after the stream is invoked cancels that request id', async () => {
  const controller = new AbortController()
  const seen = callsOf(async command => {
    if (command === 'api_stream') {
      controller.abort()
      return new Promise(() => undefined)
    }
    return undefined
  })
  await assert.rejects(
    openDesktopStream('/api/chat/stream', { method: 'POST', body: '{}', signal: controller.signal }, seen.invoke as never, () => ({ onmessage: null })),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  )
  const stream = seen.calls.filter(call => call.command === 'api_stream')
  const cancels = seen.calls.filter(call => call.command === 'api_cancel')
  assert.equal(stream.length, 1)
  assert.equal(cancels.length, 1)
  assert.equal(cancels[0]?.requestId, stream[0]?.requestId)
  assert.equal(cancels[0]?.owner, stream[0]?.owner)
  assert.equal(seen.calls.filter(call => call.command === 'api_stream_release').length, 0)
})

test('abort after the stream completes does not cancel', async () => {
  const controller = new AbortController()
  let channel: { onmessage: ((raw: string) => void) | null } = { onmessage: null }
  const seen = callsOf(async command => {
    if (command === 'api_stream') {
      channel.onmessage?.(JSON.stringify({ kind: 'status', status: 200, contentType: 'text/event-stream' }))
      channel.onmessage?.(JSON.stringify({ kind: 'end' }))
    }
    return undefined
  })
  const response = await openDesktopStream(
    '/api/chat/stream',
    { method: 'POST', body: '{}', signal: controller.signal },
    seen.invoke as never,
    () => channel,
  )
  assert.equal(response.status, 200)
  controller.abort()
  controller.abort()
  assert.equal(seen.calls.filter(call => call.command === 'api_cancel').length, 0)
  assert.equal(seen.calls.filter(call => call.command === 'api_stream_release').length, 0)
})

test('aborting twice cancels the owned request once', async () => {
  const controller = new AbortController()
  let markStarted: () => void = () => undefined
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const seen = callsOf(async command => {
    if (command === 'api_stream') {
      markStarted()
      return new Promise(() => undefined)
    }
    return undefined
  })
  const pending = openDesktopStream(
    '/api/chat/stream',
    { method: 'POST', body: '{}', signal: controller.signal },
    seen.invoke as never,
    () => ({ onmessage: null }),
  )
  await started
  controller.abort()
  controller.abort()
  assert.equal(seen.calls.filter(call => call.command === 'api_cancel').length, 1)
  assert.equal(seen.calls.filter(call => call.command === 'api_stream').length, 1)
  pending.catch(() => undefined)
})

test('readable stream cancel reaches that request once', async () => {
  let channel: { onmessage: ((raw: string) => void) | null } = { onmessage: null }
  const seen = callsOf(async command => {
    if (command === 'api_stream') {
      channel.onmessage?.(JSON.stringify({ kind: 'status', status: 200, contentType: 'text/event-stream' }))
      return new Promise(() => undefined)
    }
    return undefined
  })
  const response = await openDesktopStream(
    '/api/chat/stream',
    { method: 'POST', body: '{}' },
    seen.invoke as never,
    () => channel,
  )
  assert.equal(response.status, 200)
  await response.body?.cancel()
  await response.body?.cancel()
  const stream = seen.calls.find(call => call.command === 'api_stream')
  const cancels = seen.calls.filter(call => call.command === 'api_cancel')
  assert.equal(cancels.length, 1)
  assert.equal(cancels[0]?.requestId, stream?.requestId)
  assert.equal(cancels[0]?.owner, stream?.owner)
  assert.ok(stream?.requestId)
})

test('an already aborted signal does not start a non-stream request', () => {
  const controller = new AbortController()
  controller.abort()
  assert.equal(desktopRequestAllowed(controller.signal), false)
})
