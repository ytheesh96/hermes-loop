/** Small zero-dependency CDP client shared by Desktop profiling scripts. */

export function selectRenderer(targets, urlPattern = /^http/) {
  return targets.find(target => target.type === 'page' && urlPattern.test(target.url))
}

export async function findRenderer({ port = 9222, urlPattern = /^http/ } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  const targets = await response.json()
  const renderer = selectRenderer(targets, urlPattern)
  if (!renderer) {
    throw new Error(`renderer not found on ${port}`)
  }
  return renderer
}

export class CDPClient {
  constructor(webSocket) {
    this.webSocket = webSocket
    this.nextId = 0
    this.pending = new Map()
    this.listeners = new Map()
  }

  static async open(url) {
    const webSocket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      webSocket.addEventListener('open', resolve, { once: true })
      webSocket.addEventListener('error', reject, { once: true })
    })

    const client = new CDPClient(webSocket)
    webSocket.addEventListener('message', event => client.handleMessage(event))
    webSocket.addEventListener('close', () => client.handleClose())
    return client
  }

  handleMessage(event) {
    const text = typeof event.data === 'string' ? event.data : event.data.toString('utf8')
    const message = JSON.parse(text)
    if (message.id != null) {
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      if (message.error) request.reject(new Error(message.error.message))
      else request.resolve(message.result)
      return
    }
    for (const listener of this.listeners.get(message.method) ?? []) {
      listener(message.params)
    }
  }

  handleClose() {
    for (const request of this.pending.values()) {
      request.reject(new Error('CDP socket closed'))
    }
    this.pending.clear()
  }

  send(method, params = {}) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.webSocket.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? []
    listeners.push(listener)
    this.listeners.set(method, listeners)
  }

  async eval(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description
          ?? response.exceptionDetails.text
          ?? 'CDP evaluation failed'
      )
    }
    return response.result.value
  }

  close() {
    this.webSocket.close()
  }
}

export const connectCDP = url => CDPClient.open(url)
export const evalInPage = (client, expression) => client.eval(expression)

export async function connectRenderer(options = {}) {
  const target = await findRenderer(options)
  return { target, client: await connectCDP(target.webSocketDebuggerUrl) }
}
