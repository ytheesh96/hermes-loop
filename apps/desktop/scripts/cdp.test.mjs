import assert from 'node:assert/strict'
import test from 'node:test'

import { CDPClient, connectRenderer, selectRenderer } from './cdp.mjs'

test('selectRenderer chooses the first matching page', () => {
  const targets = [
    { type: 'browser', url: '' },
    { type: 'page', url: 'devtools://devtools' },
    { type: 'page', url: 'http://127.0.0.1:5174/' }
  ]

  assert.equal(selectRenderer(targets)?.url, 'http://127.0.0.1:5174/')
  assert.equal(selectRenderer(targets, /5174/)?.url, 'http://127.0.0.1:5174/')
})

test('selectRenderer returns undefined when no page matches', () => {
  assert.equal(selectRenderer([{ type: 'worker', url: 'http://127.0.0.1:5174/' }]), undefined)
})

test('connectRenderer discovers the target and opens its debugger socket', async t => {
  const originalFetch = globalThis.fetch
  const originalWebSocket = globalThis.WebSocket
  t.after(() => {
    globalThis.fetch = originalFetch
    globalThis.WebSocket = originalWebSocket
  })

  globalThis.fetch = async url => {
    assert.equal(url, 'http://127.0.0.1:9333/json/list')
    return {
      json: async () => [
        {
          type: 'page',
          url: 'http://127.0.0.1:5174/',
          webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/1'
        }
      ]
    }
  }
  globalThis.WebSocket = class extends EventTarget {
    constructor(url) {
      super()
      this.url = url
      queueMicrotask(() => this.dispatchEvent(new Event('open')))
    }

    close() {}
  }

  const { target, client } = await connectRenderer({ port: 9333, urlPattern: /5174/ })
  assert.equal(target.url, 'http://127.0.0.1:5174/')
  assert.equal(client.webSocket.url, 'ws://127.0.0.1/devtools/page/1')
  client.close()
})

test('CDPClient resolves out-of-order responses by request id', async () => {
  const sent = []
  const client = new CDPClient({
    send: payload => sent.push(JSON.parse(payload)),
    close() {}
  })

  const first = client.send('Runtime.evaluate', { expression: '1' })
  const second = client.send('Runtime.evaluate', { expression: '2' })
  client.handleMessage({
    data: JSON.stringify({ id: sent[1].id, result: { value: 'second' } })
  })
  client.handleMessage({
    data: JSON.stringify({ id: sent[0].id, result: { value: 'first' } })
  })

  assert.deepEqual(await first, { value: 'first' })
  assert.deepEqual(await second, { value: 'second' })
})

test('CDPClient rejects protocol errors and pending requests on close', async () => {
  const sent = []
  const client = new CDPClient({
    send: payload => sent.push(JSON.parse(payload)),
    close() {}
  })

  const failed = client.send('Runtime.evaluate')
  const failedAssertion = assert.rejects(failed, /evaluation exploded/)
  client.handleMessage({
    data: JSON.stringify({
      id: sent[0].id,
      error: { message: 'evaluation exploded' }
    })
  })
  await failedAssertion

  const pending = client.send('Page.reload')
  const closeAssertion = assert.rejects(pending, /CDP socket closed/)
  client.handleClose()
  await closeAssertion
  assert.equal(client.pending.size, 0)
})
