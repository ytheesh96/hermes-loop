import { describe, expect, it } from 'vitest'

import { classify, mergeGatewayAtCompletions, starterEntries } from './use-at-completions'

describe('at-completion task references', () => {
  it('offers @task: in the bare palette and when filtering', () => {
    expect(starterEntries('').map(entry => entry.text)).toContain('@task:')
    expect(starterEntries('tas')).toEqual([
      {
        display: '@task:',
        meta: 'attach task',
        text: '@task:'
      }
    ])
    expect(starterEntries('task:').map(entry => entry.text)).toEqual(['@task:'])
  })

  it('adds the task starter when connected to an older gateway palette', () => {
    const gatewayItems = [
      { display: '@diff', meta: 'git diff', text: '@diff' },
      { display: '@file:', meta: 'attach file', text: '@file:' }
    ]

    expect(mergeGatewayAtCompletions(gatewayItems, starterEntries('')).map(entry => entry.text)).toEqual([
      '@diff',
      '@file:',
      '@task:'
    ])
  })

  it('classifies task completions as task references', () => {
    expect(classify({ text: '@task:t_review', display: 'Review candidate' })).toEqual({
      display: 'Review candidate',
      insertId: 't_review',
      meta: '',
      type: 'task'
    })
  })
})
