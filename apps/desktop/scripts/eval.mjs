// Simple eval helper — runs an expression and returns the result.value.
import { connectRenderer } from './cdp.mjs'

const { client: cdp } = await connectRenderer({ urlPattern: /5174/ })
const expr = process.argv[2] || '1+1'
const result = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
if (result.exceptionDetails) {
  console.error('EXCEPTION:', result.exceptionDetails.exception?.description)
} else {
  console.log(JSON.stringify(result.result.value, null, 2))
}
cdp.close()
