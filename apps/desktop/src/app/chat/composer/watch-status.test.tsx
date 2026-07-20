import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { WatchComposerStatus } from './watch-status'

afterEach(cleanup)

describe('WatchComposerStatus', () => {
  it('shows the externally controlled worker state and its own model metadata', () => {
    const { container } = render(
      <WatchComposerStatus
        busy
        fast={false}
        model="openai/gpt-5.6-sol"
        provider="openai-codex"
        reasoningEffort="xhigh"
      />
    )

    expect(screen.getByRole('status').textContent).toContain('Running')
    expect(screen.getByRole('status').getAttribute('aria-atomic')).toBe('true')
    expect(screen.getByTestId('watch-composer-model').textContent).toBe('openai-codex · GPT-5.6-sol · XHigh')
    expect(screen.getByTestId('watch-composer-model').getAttribute('title')).toBe(
      'Model · openai-codex: openai/gpt-5.6-sol'
    )
    expect(container.querySelector('[contenteditable]')).toBeNull()
    expect(container.querySelector('button')).toBeNull()
  })

  it('switches to the finished state without inventing a model', () => {
    render(<WatchComposerStatus busy={false} fast={false} model="" provider="" reasoningEffort="" />)

    expect(screen.getByRole('status').textContent).toContain('Done')
    expect(screen.getByTestId('watch-composer-model').textContent).toBe('no model')
  })
})
