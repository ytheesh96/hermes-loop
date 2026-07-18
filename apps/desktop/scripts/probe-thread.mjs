// Probe the cloud shadows thread state — count messages, turn pairs,
// thread height, composer state
import { connectRenderer } from './cdp.mjs'

const { client: cdp } = await connectRenderer()
const result = await cdp.send('Runtime.evaluate', {
  expression: `JSON.stringify({
    url: location.href,
    title: document.title,
    turnPairs: document.querySelectorAll('[data-slot="aui_turn-pair"]').length,
    assistantMsgs: document.querySelectorAll('[data-slot="aui_assistant-message-root"]').length,
    userMsgs: document.querySelectorAll('[data-message-role="user"], [data-slot="aui_user-message-root"]').length,
    totalDomNodes: document.querySelectorAll('*').length,
    threadViewportScrollHeight: document.querySelector('[data-slot="aui_thread-viewport"]')?.scrollHeight ?? null,
    threadViewportClientHeight: document.querySelector('[data-slot="aui_thread-viewport"]')?.clientHeight ?? null,
    threadViewportScrollTop: document.querySelector('[data-slot="aui_thread-viewport"]')?.scrollTop ?? null,
    composer: !!document.querySelector('[data-slot="composer-rich-input"]'),
    busy: !!document.querySelector('[aria-label*="Stop"]')
  })`,
  returnByValue: true
})
console.log(JSON.parse(result.result.value))
cdp.close()
