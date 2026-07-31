import { beforeEach, describe, expect, it, vi } from 'vitest'

import { normalizeOrLocalPreviewTarget } from './local-preview'

describe('normalizeOrLocalPreviewTarget', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { hermesDesktop: undefined })
  })

  it('uses a present bridge target', async () => {
    const target = { kind: 'file' as const, path: '/tmp/report.txt', source: '/tmp/report.txt' }
    vi.stubGlobal('window', { hermesDesktop: { normalizePreviewTarget: vi.fn().mockResolvedValue(target) } })

    await expect(normalizeOrLocalPreviewTarget('/tmp/report.txt')).resolves.toMatchObject(target)
  })

  it('treats a present bridge null as authoritative', async () => {
    const normalizePreviewTarget = vi.fn().mockResolvedValue(null)
    vi.stubGlobal('window', { hermesDesktop: { normalizePreviewTarget } })

    await expect(normalizeOrLocalPreviewTarget('/tmp/missing.txt')).resolves.toBeNull()
    expect(normalizePreviewTarget).toHaveBeenCalledOnce()
  })

  it('only falls back for the known old-shell handler error', async () => {
    vi.stubGlobal('window', {
      hermesDesktop: { normalizePreviewTarget: vi.fn().mockRejectedValue(new Error('No handler registered')) }
    })

    await expect(normalizeOrLocalPreviewTarget('/tmp/report.txt')).resolves.toMatchObject({
      kind: 'file',
      path: '/tmp/report.txt'
    })
  })

  it('surfaces other bridge failures', async () => {
    vi.stubGlobal('window', { hermesDesktop: { normalizePreviewTarget: vi.fn().mockRejectedValue(new Error('denied')) } })

    await expect(normalizeOrLocalPreviewTarget('/tmp/report.txt')).rejects.toThrow('denied')
  })
})