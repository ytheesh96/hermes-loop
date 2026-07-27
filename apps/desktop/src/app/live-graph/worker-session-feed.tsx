import type { ComponentProps } from 'react'
import { useMemo, useState } from 'react'

import { MarkdownTextContent } from '@/components/assistant-ui/markdown-text'
import { USER_BUBBLE_BASE_CLASS } from '@/components/assistant-ui/thread/user-message'
import { UserMessageText } from '@/components/assistant-ui/thread/user-message-text'
import { buildToolView, clampForDisplay, type ToolPart } from '@/components/assistant-ui/tool/fallback-model'
import { CompactMarkdown } from '@/components/chat/compact-markdown'
import { DisclosureRow } from '@/components/chat/disclosure-row'
import { Codicon } from '@/components/ui/codicon'
import { ToolIcon } from '@/components/ui/tool-icon'
import { type ChatMessage, type ChatMessagePart, chatMessageText, toChatMessages } from '@/lib/chat-messages'
import { relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import type { SessionMessage } from '@/types/hermes'

interface WorkerSessionFeedProps {
  emptyLabel: string
  messages: SessionMessage[]
  sessionId?: string
}

type ToolCallPart = Extract<ChatMessagePart, { type: 'tool-call' }>

function messageAge(timestamp?: number): string {
  if (!timestamp) {
    return ''
  }

  const timestampMs = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp

  return Number.isFinite(timestampMs) ? relativeTime(timestampMs) : ''
}

function visibleSessionMessages(messages: SessionMessage[]): ChatMessage[] {
  return toChatMessages(messages).filter(message => !message.hidden)
}

function WorkerSessionMessageAge({ timestamp }: { timestamp?: number }) {
  const age = messageAge(timestamp)

  return age ? <time className="self-end text-[0.625rem] text-(--ui-text-quaternary)">{age}</time> : null
}

function WorkerSessionToolRow({ part }: { part: ToolCallPart }) {
  const [open, setOpen] = useState(false)

  const toolPart = useMemo<ToolPart>(
    () => ({
      args: part.args,
      isError: part.isError,
      result: part.result,
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      type: 'tool-call'
    }),
    [part.args, part.isError, part.result, part.toolCallId, part.toolName]
  )

  const view = useMemo(() => buildToolView(toolPart, ''), [toolPart])

  const detail = view.stdout || view.stderr ? [view.stdout, view.stderr].filter(Boolean).join('\n\n') : view.detail
  const hasDetail = Boolean(detail)

  const preview =
    view.subtitle ||
    detail
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean) ||
    ''

  return (
    <div
      className={cn(
        'min-w-0 max-w-full overflow-hidden text-(--ui-text-tertiary)',
        open && 'rounded-[0.3125rem] border border-(--ui-stroke-tertiary)'
      )}
      data-live-graph-session-tool
      data-tool-row=""
    >
      <div className={cn(open && 'border-b border-(--ui-stroke-tertiary) px-2 py-1.5')}>
        <DisclosureRow onToggle={hasDetail ? () => setOpen(current => !current) : undefined} open={open}>
          <span className="flex min-w-0 items-center gap-1.5">
            <ToolIcon className="text-(--ui-text-tertiary)" name={view.icon || 'tools'} size="0.75rem" />
            <span
              className={cn(
                'truncate text-[0.6875rem] font-medium leading-4 text-(--ui-text-secondary)',
                view.status === 'error' && 'text-destructive'
              )}
            >
              {view.title}
            </span>
            {view.countLabel && (
              <span className="shrink-0 text-[0.625rem] tabular-nums text-(--ui-text-quaternary)">
                {view.countLabel}
              </span>
            )}
          </span>
          {preview && !open && (
            <span className="line-clamp-1 max-w-full text-[0.625rem] leading-4 text-(--ui-text-quaternary)">
              {preview}
            </span>
          )}
        </DisclosureRow>
      </div>
      {open && detail && (
        <CompactMarkdown
          className={cn(
            'max-h-56 overflow-auto px-2 py-1.5 text-[0.6875rem] text-(--ui-text-secondary)',
            view.status === 'error' && 'text-destructive'
          )}
          text={clampForDisplay(detail)}
        />
      )}
    </div>
  )
}

function WorkerSessionReasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="text-(--ui-text-tertiary)" data-live-graph-session-reasoning>
      <DisclosureRow onToggle={() => setOpen(current => !current)} open={open}>
        <span className="flex items-center gap-1.5 text-[0.6875rem] font-medium leading-4">
          <Codicon name="lightbulb" size="0.75rem" />
          Thinking
        </span>
      </DisclosureRow>
      {open && (
        <MarkdownTextContent
          containerClassName="mt-1 text-[0.6875rem] leading-4 text-(--ui-text-tertiary)"
          isRunning={false}
          text={text}
        />
      )}
    </div>
  )
}

function WorkerAssistantMessage({ message }: { message: ChatMessage }) {
  const visibleParts = message.parts.filter(
    part =>
      (part.type === 'text' && part.text.trim()) ||
      (part.type === 'reasoning' && part.text.trim()) ||
      part.type === 'tool-call'
  )

  if (visibleParts.length === 0) {
    return null
  }

  return (
    <article className="grid min-w-0 max-w-full gap-1.5" data-live-graph-session-message data-role="assistant">
      {visibleParts.map((part, index) => {
        if (part.type === 'tool-call') {
          return <WorkerSessionToolRow key={part.toolCallId || `${part.toolName}:${index}`} part={part} />
        }

        if (part.type === 'reasoning') {
          return <WorkerSessionReasoning key={`reasoning:${index}`} text={part.text} />
        }

        if (part.type === 'text') {
          return (
            <MarkdownTextContent
              containerClassName="text-[0.6875rem] leading-4 text-(--ui-text-secondary)"
              containerProps={
                {
                  'data-live-graph-session-markdown': ''
                } as ComponentProps<'div'>
              }
              isRunning={false}
              key={`text:${index}`}
              text={part.text}
            />
          )
        }

        return null
      })}
      <WorkerSessionMessageAge timestamp={message.timestamp} />
    </article>
  )
}

function WorkerUserMessage({ message }: { message: ChatMessage }) {
  const text = chatMessageText(message).trim()

  if (!text) {
    return null
  }

  return (
    <article className="grid min-w-0 max-w-full gap-1" data-live-graph-session-message data-role="user">
      <div className={cn(USER_BUBBLE_BASE_CLASS, 'cursor-default text-[0.6875rem] leading-4 text-(--ui-text-primary)')}>
        <UserMessageText className="wrap-anywhere" text={text} />
      </div>
      <WorkerSessionMessageAge timestamp={message.timestamp} />
    </article>
  )
}

function WorkerSystemMessage({ message }: { message: ChatMessage }) {
  const text = chatMessageText(message).trim()

  if (!text) {
    return null
  }

  return (
    <article
      className="grid min-w-0 max-w-full gap-1 rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) px-2.5 py-2 text-[0.625rem] leading-4 text-(--ui-text-tertiary)"
      data-live-graph-session-message
      data-role="system"
    >
      <div className="flex min-w-0 items-start gap-1.5">
        <Codicon className="mt-0.5 shrink-0" name="info" size="0.6875rem" />
        <UserMessageText className="min-w-0 flex-1 wrap-anywhere" text={text} />
      </div>
      <WorkerSessionMessageAge timestamp={message.timestamp} />
    </article>
  )
}

export function WorkerSessionFeed({ emptyLabel, messages, sessionId }: WorkerSessionFeedProps) {
  const visibleMessages = useMemo(() => visibleSessionMessages(messages), [messages])

  if (visibleMessages.length === 0) {
    return <p className="m-0 text-[0.6875rem] leading-4 text-(--ui-text-tertiary)">{emptyLabel}</p>
  }

  return (
    <div
      className="grid min-w-0 max-w-full gap-4 [--conversation-caption-font-size:0.625rem] [--conversation-line-height:1rem] [--conversation-text-font-size:0.6875rem] [--conversation-tool-font-size:0.6875rem] [--dt-line-height:1rem] [--paragraph-gap:0.4rem]"
      data-live-graph-worker-session-feed
      data-session-id={sessionId || undefined}
      data-testid="live-graph-task-worker-transcript"
    >
      {visibleMessages.map(message => {
        if (message.role === 'user') {
          return <WorkerUserMessage key={message.id} message={message} />
        }

        if (message.role === 'system') {
          return <WorkerSystemMessage key={message.id} message={message} />
        }

        return <WorkerAssistantMessage key={message.id} message={message} />
      })}
    </div>
  )
}
