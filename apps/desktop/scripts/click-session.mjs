// Click on a session by partial title match.
import { connectRenderer } from './cdp.mjs'

const { client: cdp } = await connectRenderer()
const title = process.argv[2] || 'Phaser particle'
const result = await cdp.send('Runtime.evaluate', {
  expression: `
    (() => {
      const titleMatch = ${JSON.stringify(title)}
      const all = document.querySelectorAll('button, a, div[role="button"]')
      const found = [...all].find(el => (el.textContent || '').includes(titleMatch))
      if (!found) return JSON.stringify({ found: false, tried: titleMatch })
      found.scrollIntoView()
      found.click()
      return JSON.stringify({ found: true, tag: found.tagName, text: (found.textContent || '').slice(0, 80) })
    })()
  `,
  returnByValue: true
})
console.log('click raw:', JSON.stringify({ result }, null, 2))
await new Promise(r => setTimeout(r, 3000))

const status = await cdp.send('Runtime.evaluate', {
  expression: `JSON.stringify({
    url: location.href,
    hasComposer: !!document.querySelector('[data-slot="composer-rich-input"]'),
    threadMessages: document.querySelectorAll('[data-slot="aui_message"]').length,
    bodyTextSnippet: document.body.innerText.slice(0, 500),
    title: document.title
  })`,
  returnByValue: true
})
console.log('after click:', status.result.value)
cdp.close()
