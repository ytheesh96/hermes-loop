import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { setFileBrowserOpen } from '@/store/layout'

import { TitlebarControls } from './titlebar-controls'

vi.mock('@/lib/haptics', () => ({ triggerHaptic: vi.fn() }))

describe('TitlebarControls', () => {
  beforeEach(() => setFileBrowserOpen(false))

  afterEach(() => {
    cleanup()
    setFileBrowserOpen(false)
  })

  it('labels the right-edge toggle for the Files pane it owns', () => {
    render(
      <MemoryRouter>
        <I18nProvider configClient={null}>
          <TitlebarControls onOpenSettings={vi.fn()} />
        </I18nProvider>
      </MemoryRouter>
    )

    const toggle = screen.getByRole('button', { name: 'Show files sidebar' })

    fireEvent.click(toggle)

    expect(screen.getByRole('button', { name: 'Hide files sidebar' })).toBe(toggle)
  })
})
