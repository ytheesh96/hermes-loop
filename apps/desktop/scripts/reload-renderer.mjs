// Reload the renderer via CDP so it picks up the latest from Vite.
import { connectRenderer } from './cdp.mjs'

const { client: cdp } = await connectRenderer()
await cdp.send('Page.enable')
await cdp.send('Page.reload', { ignoreCache: true })
console.log('reload requested')
await new Promise(r => setTimeout(r, 200))
cdp.close()
