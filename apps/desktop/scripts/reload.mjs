// Hard reload the Electron renderer over CDP. Vite-no-HMR mode means edits
// don't auto-apply — call this after editing source.
import { connectRenderer, evalInPage } from './cdp.mjs'

let cdp
try {
  const connection = await connectRenderer({ urlPattern: /5174/ })
  cdp = connection.client
} catch {
  console.error('renderer not found')
  process.exit(1)
}

await cdp.send('Page.reload', { ignoreCache: true })
console.log('reload sent')
// Wait for new doc.
await new Promise((r) => setTimeout(r, 2500))
const result = await evalInPage(
  cdp,
  'JSON.stringify({ hasProbe: !!window.__PERF_PROBE__, composer: !!document.querySelector("[contenteditable=true]"), url: location.hash })'
)
console.log(result)
cdp.close()
