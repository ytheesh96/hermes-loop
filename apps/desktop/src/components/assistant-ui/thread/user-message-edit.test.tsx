import { ExportedMessageRepository } from '@assistant-ui/react'
// Clicking a user bubble must open the inline edit composer — through the
// app's incremental external-store runtime (which reimplements capability
// resolution, incl. `edit: onEdit !== undefined`) and the stock runtime.
//
// Note: this covers the React/runtime wiring only. The Electron-level failure
// mode (titlebar -webkit-app-region:drag swallowing clicks on *stuck* sticky
// bubbles) is not reproducible in jsdom — see USER_BUBBLE_BASE_CLASS's no-drag
// carve-out in thread.tsx.
import { AssistantRuntimeProvider, type ThreadMessage, useExternalStoreRuntime } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useIncrementalExternalStoreRuntime } from '@/lib/incremental-external-store-runtime'

import { Thread } from '.'

const createdAt = new Date('2026-05-01T00:00:00.000Z')

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', TestResizeObserver)
vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
  window.setTimeout(() => callback(performance.now()), 0)
)
vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
vi.stubGlobal('CSS', { escape: (str: string) => str })

Element.prototype.scrollTo = function scrollTo() {}

afterEach(() => {
  cleanup()
})

function stubOffsetDimension(
  prop: 'offsetHeight' | 'offsetWidth',
  clientProp: 'clientHeight' | 'clientWidth',
  fallback: number
) {
  const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop)

  Object.defineProperty(HTMLElement.prototype, prop, {
    configurable: true,
    get() {
      return previous?.get?.call(this) || (this as HTMLElement)[clientProp] || fallback
    }
  })
}

stubOffsetDimension('offsetWidth', 'clientWidth', 800)
stubOffsetDimension('offsetHeight', 'clientHeight', 600)

function userMessage(): ThreadMessage {
  return {
    id: 'user-1',
    role: 'user',
    content: [{ type: 'text', text: 'edit me please' }],
    attachments: [],
    createdAt,
    metadata: { custom: {} }
  } as ThreadMessage
}

function assistantMessage(): ThreadMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: [{ type: 'text', text: 'done' }],
    status: { type: 'complete', reason: 'stop' },
    createdAt,
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: {}
    }
  } as ThreadMessage
}

function handoffMessage(): ThreadMessage {
  return {
    id: 'handoff-user-1',
    role: 'user',
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            handoff_count: 1,
            instructions: [
              'Treat visible_cards as transcript artifacts only: title, one-line summary, and Open drawer.'
            ],
            kind: 'kanban_loop_handoff_review_batch',
            review_batch_id: 'loop-review:sess:t_root:123',
            root_task_id: 't_root',
            tenant: 'sess',
            transcript_card_contract: 'handoff-a-minimal',
            visible_cards: [
              {
                action: 'Open drawer',
                payload_ref: 'loop_handoff:5',
                summary: 'Worker found a UI issue that needs review.',
                task_title: 'Foreground handoff smoke loop'
              }
            ]
          },
          null,
          2
        ).replace(/^ +/gm, spaces => '\u00a0'.repeat(spaces.length))
      }
    ],
    attachments: [],
    createdAt,
    metadata: { custom: {} }
  } as ThreadMessage
}

// Mirrors chat/index.tsx: incremental runtime + messageRepository + onEdit.
function IncrementalHarness({ isRunning = false, onEdit }: { isRunning?: boolean; onEdit: () => Promise<void> }) {
  const repository = ExportedMessageRepository.fromArray([userMessage(), assistantMessage()])

  const runtime = useIncrementalExternalStoreRuntime<ThreadMessage>({
    messageRepository: repository,
    isRunning,
    setMessages: () => {},
    onNew: async () => {},
    onEdit,
    onCancel: async () => {},
    onReload: async () => {}
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  )
}

// Control: stock external store runtime.
function StockHarness({ onEdit }: { onEdit: () => Promise<void> }) {
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    messages: [userMessage(), assistantMessage()],
    isRunning: false,
    onNew: async () => {},
    onEdit
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  )
}

function HandoffHarness({ onOpenKanbanTask }: { onOpenKanbanTask?: (taskId: string) => void }) {
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    messages: [handoffMessage()],
    isRunning: false,
    onNew: async () => {},
    onEdit: async () => {}
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread onOpenKanbanTask={onOpenKanbanTask} />
    </AssistantRuntimeProvider>
  )
}

describe('click-to-edit user message', () => {
  it('creates the running assistant placeholder with the incremental runtime', () => {
    expect(() => render(<IncrementalHarness isRunning onEdit={async () => {}} />)).not.toThrow()
  })

  it('opens the edit composer with the incremental runtime', async () => {
    const { container } = render(<IncrementalHarness onEdit={async () => {}} />)

    const bubble = await screen.findByRole('button', { name: 'Edit message' })

    fireEvent.click(bubble)

    await waitFor(() => {
      expect(container.querySelector('[data-slot="aui_edit-composer-root"]')).toBeTruthy()
    })
  })

  it('opens the edit composer with the stock runtime', async () => {
    const { container } = render(<StockHarness onEdit={async () => {}} />)

    const bubble = await screen.findByRole('button', { name: 'Edit message' })

    fireEvent.click(bubble)

    await waitFor(() => {
      expect(container.querySelector('[data-slot="aui_edit-composer-root"]')).toBeTruthy()
    })
  })

  it('renders foreground handoff payloads as non-editable review cards', async () => {
    render(<HandoffHarness />)

    const card = await screen.findByTestId('loop-handoff-review-batch')

    expect(card.textContent).toContain('Loop handoff review')
    expect(card.textContent).toContain('Foreground handoff smoke loop')
    expect(card.textContent).toContain('Worker found a UI issue that needs review.')
    expect(card.textContent).toContain('loop_handoff:5')
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull()
    expect(screen.queryByText(/"kind"\s*:\s*"kanban_loop_handoff_review_batch"/)).toBeNull()
  })

  it('opens the Loop drawer for a foreground handoff card', async () => {
    const onOpenKanbanTask = vi.fn()

    render(<HandoffHarness onOpenKanbanTask={onOpenKanbanTask} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Open drawer for Foreground handoff smoke loop' }))

    expect(onOpenKanbanTask).toHaveBeenCalledWith('t_root')
  })
})
