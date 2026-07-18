// CPU-profile a synthetic stream — outputs a .cpuprofile and a top-self ranking.
// Open the .cpuprofile in Chrome DevTools Performance panel for a flamegraph.

import { writeFileSync } from 'node:fs'
import { connectCDP, findRenderer } from './cdp.mjs'

const TOKENS = Number(process.env.TOKENS || 400)
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 8)
const CHUNK = process.env.CHUNK || '**word** in _italic_ with `code` '
const LABEL = process.env.LABEL || 'profile'
const OUT = process.env.OUT || `synth-${LABEL}.cpuprofile`

async function main() {
  const target = await findRenderer({ urlPattern: /5174/ })
  const cdp = await connectCDP(target.webSocketDebuggerUrl)

  if (!await cdp.eval('!!window.__PERF_DRIVE__')) {
    console.error('no __PERF_DRIVE__')
    cdp.close()
    process.exit(2)
  }

  await cdp.send('Profiler.enable')
  // High-resolution sampling: 100us
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 })
  await cdp.send('Profiler.start')

  await cdp.eval(`window.__PERF_DRIVE__.stream({ chunk: ${JSON.stringify(CHUNK)}, intervalMs: ${INTERVAL_MS}, totalTokens: ${TOKENS} })`)
  await new Promise((r) => setTimeout(r, TOKENS * INTERVAL_MS + 1500))
  await cdp.eval('window.__PERF_DRIVE__.reset()')

  const { profile } = await cdp.send('Profiler.stop')
  writeFileSync(OUT, JSON.stringify(profile))
  console.log('wrote', OUT)

  // Compute top self time per function.
  const samples = profile.samples || []
  const timeDeltas = profile.timeDeltas || []
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]))
  const selfTime = new Map() // id -> microseconds
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i]
    const dt = timeDeltas[i] ?? 0
    selfTime.set(id, (selfTime.get(id) || 0) + dt)
  }
  const ranked = [...selfTime.entries()]
    .map(([id, us]) => {
      const n = nodes.get(id)
      const cf = n?.callFrame || {}
      return {
        us,
        ms: us / 1000,
        name: cf.functionName || '(anonymous)',
        url: (cf.url || '').slice(-60),
        line: cf.lineNumber
      }
    })
    .filter((x) => !/\(root\)|\(idle\)|\(garbage collector\)|\(program\)/.test(x.name))
    .sort((a, b) => b.us - a.us)
    .slice(0, 30)

  console.log('\n=== TOP 30 SELF TIME (ms) ===')
  for (const r of ranked) {
    console.log(`${r.ms.toFixed(1).padStart(7)}  ${r.name.padEnd(40)}  ${r.url}:${r.line}`)
  }

  cdp.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
