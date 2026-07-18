// quick probe — read state of the renderer
import { connectRenderer } from './cdp.mjs'

const { target, client: cdp } = await connectRenderer()
console.log('target:', target.url)
const result = await cdp.send('Runtime.evaluate', {
  expression: `({
    url: location.href,
    title: document.title,
    rootChildren: document.getElementById('root')?.children.length ?? 0,
    rootInner: (document.getElementById('root')?.innerHTML ?? '').slice(0, 300),
    hasComposer: !!document.querySelector('[data-slot="composer-rich-input"]'),
    bootStage: (document.querySelector('[data-slot*="boot"]')?.getAttribute('data-slot')) ?? null,
    bodyText: document.body.innerText.slice(0, 300),
    errorCount: window.__errors?.length ?? 'n/a'
  })`,
  returnByValue: true
})
console.log('raw:', JSON.stringify({ result }, null, 2))
cdp.close()
