import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { credentialStatusLine } from '../utils/credentials.ts'
import { discardEarlierCredential, UNBOUND_CREDENTIAL_WARNING, confirmUnscopedRecovery } from '../utils/confirmUnscopedRecovery.ts'

const SENTINEL = 'DOCXEDITOR_SECRET_SENTINEL_9f2c'

function status(partial: Record<string, unknown>) {
  return {
    has_key: false,
    hint: '',
    mode: 'unavailable',
    persistent: false,
    source: 'missing',
    unbound_profile_credential: true,
    ...partial,
  }
}

test('startup does not rebind an unscoped credential', () => {
  const source = readFileSync(new URL('../context/EditorContext.tsx', import.meta.url), 'utf8')
  const manager = readFileSync(new URL('../components/ModelManager.tsx', import.meta.url), 'utf8')
  const helpers = readFileSync(new URL('../utils/credentials.ts', import.meta.url), 'utf8')
  assert.equal(source.includes('rebindUnscopedCredential'), false)
  assert.equal(source.includes('/rebind'), false)
  assert.equal(manager.includes('rebindUnscopedCredential'), false)
  assert.equal(helpers.includes('rebindUnscopedCredential'), false)
  assert.equal(UNBOUND_CREDENTIAL_WARNING.includes('A credential from an earlier version needs provider confirmation.'), true)
  assert.equal(UNBOUND_CREDENTIAL_WARNING.includes('cannot tell which provider'), true)
  assert.equal(manager.includes('{UNBOUND_CREDENTIAL_WARNING}'), true)
  assert.equal(manager.includes('Confirm provider'), true)
  assert.equal(manager.includes('Discard earlier credential'), true)
  const recover = manager.slice(manager.indexOf('const handleRecover'), manager.indexOf('const handleDiscardEarlier'))
  assert.equal(recover.includes('window.confirm'), true)
  assert.ok(recover.indexOf('window.confirm') < recover.indexOf('confirmUnscopedRecovery'))
  assert.equal(recover.includes('if (!agreed) return'), true)
  assert.equal(recover.includes('setRecoveryMessage(result.ok ? null : result.message)'), true)
  assert.equal(recover.includes('now saved'), false)
  assert.ok(recover.indexOf('if (result.ok && result.status)') < recover.indexOf('setListStatus'))
  const discard = manager.slice(manager.indexOf('const handleDiscardEarlier'), manager.indexOf('const editorLine'))
  assert.equal(discard.includes('window.confirm'), true)
  assert.ok(discard.indexOf('window.confirm') < discard.indexOf('discardEarlierCredential'))
  assert.equal(discard.includes('deleteModel'), false)
  const line = credentialStatusLine({
    has_key: false,
    hint: '',
    mode: 'unavailable',
    persistent: false,
    source: 'missing',
    unbound_profile_credential: true,
  }, false)
  assert.equal(line.includes(SENTINEL), false)
  assert.equal(line.includes('earlier version'), false)
})

test('explicit confirmation is required before rebind', async () => {
  let calls = 0
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    calls += 1
    return new Response('{}', { status: 500 })
  }) as typeof fetch
  try {
    const skipped = await confirmUnscopedRecovery({
      profileId: 'profile-a',
      provider: 'anthropic',
      confirmed: false,
    })
    assert.equal(skipped.ok, false)
    assert.equal(skipped.reason, 'not-confirmed')
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = original
  }
})

test('confirmed recovery posts only the chosen provider and requires a profile read-back', async () => {
  const original = globalThis.fetch
  const calls: { method: string; url: string; body: string }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = typeof init?.body === 'string' ? init.body : ''
    calls.push({ method: init?.method || 'GET', url, body })
    assert.equal(url.includes(SENTINEL), false)
    assert.equal(body.includes(SENTINEL), false)
    if ((init?.method || 'GET') === 'POST') {
      assert.deepEqual(JSON.parse(body), { provider: 'anthropic' })
      assert.equal(body.includes('api_key'), false)
      return new Response(JSON.stringify(status({
        has_key: true,
        hint: '••••9f2c',
        mode: 'keyring',
        persistent: true,
        source: 'profile',
        unbound_profile_credential: false,
        rebound: true,
        other_profile_same_secret: false,
      })), { status: 200 })
    }
    if (url.includes('provider=anthropic') && calls.filter(call => call.method === 'POST').length === 0) {
      return new Response(JSON.stringify(status({ source: 'missing' })), { status: 200 })
    }
    if (url.includes('provider=anthropic')) {
      return new Response(JSON.stringify(status({
        has_key: true,
        hint: '••••9f2c',
        mode: 'keyring',
        persistent: true,
        source: 'profile',
        unbound_profile_credential: false,
      })), { status: 200 })
    }
    return new Response(JSON.stringify(status({
      source: 'missing',
      unbound_profile_credential: false,
    })), { status: 200 })
  }) as typeof fetch
  try {
    const result = await confirmUnscopedRecovery({
      profileId: 'profile-a',
      provider: 'anthropic',
      confirmed: true,
    })
    assert.equal(result.ok, true)
    assert.equal(calls.filter(call => call.method === 'POST').length, 1)
    assert.equal(result.status?.source, 'profile')
    assert.equal(result.status?.unbound_profile_credential, false)
  } finally {
    globalThis.fetch = original
  }
})

test('a failed or unverified rebind is not success and keeps the unbound status', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if ((init?.method || 'GET') === 'POST') {
      return new Response(JSON.stringify({ error: 'no' }), { status: 503 })
    }
    if (url.includes('provider=openai') && (init?.method || 'GET') === 'GET') {
      return new Response(JSON.stringify(status({
        has_key: true,
        hint: '••••aaaa',
        source: 'profile',
        mode: 'keyring',
        persistent: true,
        unbound_profile_credential: true,
      })), { status: 200 })
    }
    return new Response('{}', { status: 500 })
  }) as typeof fetch
  try {
    const already = await confirmUnscopedRecovery({
      profileId: 'profile-a',
      provider: 'openai',
      confirmed: true,
    })
    assert.equal(already.ok, false)
    assert.equal(already.reason, 'already-scoped')
    assert.equal(already.status?.unbound_profile_credential, true)
  } finally {
    globalThis.fetch = original
  }

  let posts = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method || 'GET') === 'POST') {
      posts += 1
      return new Response(JSON.stringify(status({ source: 'profile', has_key: true, unbound_profile_credential: false })), { status: 200 })
    }
    const url = String(input)
    if (url.includes('provider=openai') && posts === 0) {
      return new Response(JSON.stringify(status({ source: 'missing' })), { status: 200 })
    }
    return new Response(JSON.stringify(status({
      source: 'missing',
      unbound_profile_credential: true,
    })), { status: 200 })
  }) as typeof fetch
  try {
    const failed = await confirmUnscopedRecovery({
      profileId: 'profile-a',
      provider: 'openai',
      confirmed: true,
    })
    assert.equal(failed.ok, false)
    assert.equal(failed.message.includes('did not complete'), true)
    assert.equal(failed.status?.unbound_profile_credential, true)
  } finally {
    globalThis.fetch = original
  }
})

test('a rebind response that echoes a secret is rejected', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method || 'GET') === 'POST') {
      return new Response(JSON.stringify({ source: 'profile', api_key: SENTINEL }), { status: 200 })
    }
    return new Response(JSON.stringify(status({ source: 'missing' })), { status: 200 })
  }) as typeof fetch
  try {
    const result = await confirmUnscopedRecovery({
      profileId: 'profile-a',
      provider: 'openai',
      confirmed: true,
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'response-rejected')
    assert.equal(result.message.includes('now saved'), false)
    assert.equal(result.message.includes(SENTINEL), false)
  } finally {
    globalThis.fetch = original
  }
})

test('the backend same-secret flag rejects a bind without comparing hints', async () => {
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method || 'GET'
    calls.push(method)
    if (method === 'POST') {
      return new Response(JSON.stringify(status({
        has_key: true,
        hint: '••••9f2c',
        source: 'profile',
        mode: 'keyring',
        persistent: true,
        unbound_profile_credential: false,
        rebound: true,
        other_profile_same_secret: true,
      })), { status: 200 })
    }
    if (url.includes('provider=anthropic') && calls.filter(call => call === 'POST').length === 0) {
      return new Response(JSON.stringify(status({ source: 'missing' })), { status: 200 })
    }
    return new Response(JSON.stringify(status({
      has_key: true,
      hint: '••••9f2c',
      source: 'profile',
      mode: 'keyring',
      persistent: true,
      unbound_profile_credential: false,
    })), { status: 200 })
  }) as typeof fetch
  try {
    const result = await confirmUnscopedRecovery({
      profileId: 'profile-a',
      provider: 'anthropic',
      confirmed: true,
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'other-provider')
    assert.equal(result.message.includes('now saved'), false)
    assert.equal(calls.filter(call => call === 'POST').length, 1)
  } finally {
    globalThis.fetch = original
  }
})

test('discard is explicit and a failed discard does not report removal', async () => {
  const original = globalThis.fetch
  const calls: { method: string; url: string; body: string }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = typeof init?.body === 'string' ? init.body : ''
    calls.push({ method: init?.method || 'GET', url, body })
    assert.equal(body.includes(SENTINEL), false)
    assert.equal(url.includes('/discard-unscoped'), true)
    return new Response(JSON.stringify({ discarded: true, unbound_profile_credential: false }), { status: 200 })
  }) as typeof fetch
  try {
    const removed = await discardEarlierCredential('profile-a')
    assert.equal(removed, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[0].body, '')
  } finally {
    globalThis.fetch = original
  }

  globalThis.fetch = (async () => new Response(JSON.stringify({
    error: { code: 'credential_store_failed', message: 'The earlier credential could not be discarded.' },
  }), { status: 503 })) as typeof fetch
  try {
    const kept = await discardEarlierCredential('profile-a')
    assert.equal(kept, false)
  } finally {
    globalThis.fetch = original
  }
})
