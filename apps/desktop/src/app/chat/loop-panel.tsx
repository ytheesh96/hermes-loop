import { useMemo, useState } from 'react'

import { StatusRow } from '@/components/chat/status-row'
import { StatusSection } from '@/components/chat/status-section'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'

import type { LoopPanelState, LoopPanelStatus, LoopRow } from './loop-state'

function statusCopy(status: LoopPanelStatus): string {
  if (status === 'stale') {
    return 'Stale revision'
  }

  if (status === 'error') {
    return 'Error'
  }

  return 'Live draft'
}

type LoopStatusKind = 'blocked' | 'done' | 'pending' | 'running' | 'slashed'

function statusIndicatorKind(status: string): LoopStatusKind {
  const value = status.toLowerCase()

  if (value === 'running' || value === 'in_progress' || value === 'claimed') {
    return 'running'
  }

  if (value === 'done' || value === 'complete' || value === 'completed') {
    return 'done'
  }

  if (value === 'cancelled' || value === 'canceled' || value === 'archived') {
    return 'slashed'
  }

  if (value === 'blocked' || value === 'error' || value === 'failed' || value === 'stale') {
    return 'blocked'
  }

  return 'pending'
}

function StatusGlyph({ kind }: { kind: LoopStatusKind }) {
  if (kind === 'running') {
    return <span aria-hidden="true" className="size-3 rounded-full border border-(--ui-accent)/25 border-t-(--ui-accent) animate-spin" />
  }

  if (kind === 'done') {
    return <Codicon className="text-emerald-500/90" name="check" size="0.78rem" />
  }

  if (kind === 'slashed') {
    return <Codicon className="text-(--ui-text-tertiary)" name="circle-slash" size="0.78rem" />
  }

  if (kind === 'blocked') {
    return <span aria-hidden="true" className="size-1.5 rounded-full bg-destructive" />
  }

  return <span aria-hidden="true" className="size-3.5 rounded-full border border-foreground/35 bg-transparent" />
}

function LoopStatusIndicator({ row }: { row: LoopRow }) {
  const kind = statusIndicatorKind(row.status)

  return (
    <span
      aria-label={`Status: ${row.status}`}
      className="grid w-3.5 shrink-0 place-items-center overflow-hidden"
      data-status-kind={kind}
      role="img"
    >
      <StatusGlyph kind={kind} />
    </span>
  )
}

function completedLoopRows(rows: LoopRow[]): number {
  return rows.filter(row => {
    const status = row.status.toLowerCase()

    return status === 'done' || status === 'complete' || status === 'completed'
  }).length
}

function selectedRowFrom(state: LoopPanelState | null, selectedTaskId?: null | string): LoopRow | null {
  if (!state) {
    return null
  }

  return state.rows.find(row => row.taskId === selectedTaskId) || state.rows[0] || null
}

interface LoopStackRowProps {
  onSelect: (taskId: string) => void
  row: LoopRow
  selected: boolean
}

function LoopStackRow({ onSelect, row, selected }: LoopStackRowProps) {
  return (
    <div data-testid={`loop-card-${row.taskId}`}>
      <StatusRow
        className={cn(selected && 'bg-(--ui-row-hover-background)')}
        leading={<LoopStatusIndicator row={row} />}
        onActivate={() => onSelect(row.taskId)}
      >
        <span
          className={cn(
            'min-w-0 max-w-[18rem] truncate text-[0.73rem] leading-4',
            selected ? 'text-foreground/92' : 'text-muted-foreground/75'
          )}
        >
          {row.title}
        </span>
      </StatusRow>
    </div>
  )
}

interface LoopTaskStackProps {
  onSelectTaskId: (taskId: string) => void
  selectedTaskId?: null | string
  state: LoopPanelState | null
}

export function LoopTaskStack({ onSelectTaskId, selectedTaskId, state }: LoopTaskStackProps) {
  const selected = useMemo(() => selectedRowFrom(state, selectedTaskId), [selectedTaskId, state])

  if (!state || state.rows.length === 0) {
    return null
  }

  return (
    <StatusSection
      defaultCollapsed={false}
      icon={<Codicon className="text-muted-foreground/70" name="checklist" size="0.8rem" />}
      label={`Loop ${completedLoopRows(state.rows)}/${state.rows.length}`}
    >
      {state.rows.map(row => (
        <LoopStackRow
          key={row.taskId}
          onSelect={onSelectTaskId}
          row={row}
          selected={selected?.taskId === row.taskId}
        />
      ))}
    </StatusSection>
  )
}

function dependencyListLabel(values: string[] | undefined): string {
  if (!values) {
    return 'unavailable'
  }

  return values.length ? values.join(', ') : 'none'
}

function LoopDetailLine({ label, value }: { label: string; value?: string }) {
  if (!value) {
    return null
  }

  return <div>{label}: {value}</div>
}

interface LoopPanelProps {
  hidden?: boolean
  onHide?: () => void
  open?: boolean
  selectedTaskId?: null | string
  state: LoopPanelState | null
}

export function LoopPanel({ hidden = false, onHide, open = false, selectedTaskId, state }: LoopPanelProps) {
  const [debugOpen, setDebugOpen] = useState(false)

  const selected = useMemo(() => selectedRowFrom(state, selectedTaskId), [selectedTaskId, state])

  if (!state || hidden) {
    return null
  }

  return (
    <aside
      className={cn(
        'flex w-[min(20rem,45vw)] shrink-0 flex-col border-l border-(--ui-stroke-secondary) bg-(--ui-sidebar-background) p-3 text-(--ui-text-secondary)',
        !open && 'hidden xl:flex'
      )}
      data-testid="loop-panel"
    >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="m-0 text-sm font-semibold text-(--ui-text-primary)">Loop</h2>
            <p className="m-0 mt-0.5 text-xs text-(--ui-text-tertiary)">
              {statusCopy(state.status)} · rev {state.revision || '—'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {state.rootTaskId && (
              <span className="rounded bg-(--ui-fill-quaternary) px-1.5 py-0.5 font-mono text-[0.65rem] text-(--ui-text-tertiary)">
                {state.rootTaskId}
              </span>
            )}
            {onHide && (
              <Button aria-label="Hide Loop panel" className="size-7 p-0" onClick={onHide} type="button" variant="ghost">
                <Codicon name="close" size="0.875rem" />
              </Button>
            )}
          </div>
        </div>

        {state.message && (
          <div
            className={cn(
              'mb-3 rounded-lg border px-2 py-1.5 text-xs',
              state.status === 'stale'
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                : 'border-destructive/30 bg-destructive/10 text-destructive'
            )}
          >
            {state.message}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {selected ? (
            <section className="rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-surface-background) p-3 text-xs">
              <h3 className="m-0 mb-2 text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">
                Loop details
              </h3>
              <div className="grid gap-1.5">
                <div className="flex items-center gap-2 font-medium text-(--ui-text-primary)">
                  <LoopStatusIndicator row={selected} />
                  <span className="min-w-0 truncate">{selected.title}</span>
                </div>
                <LoopDetailLine label="Task ID" value={selected.taskId} />
                <LoopDetailLine label="Status" value={selected.status} />
                <LoopDetailLine label="Board" value={selected.board} />
                <LoopDetailLine label="Tenant" value={selected.tenant} />
                <LoopDetailLine label="Root" value={selected.rootTaskId || state.rootTaskId} />
                <div>Parents: {dependencyListLabel(selected.parents)}</div>
                <div>Dependents: {dependencyListLabel(selected.children)}</div>
                <LoopDetailLine label="Attention" value={selected.attention} />
                <LoopDetailLine label="Verification" value={selected.verificationState} />
                <LoopDetailLine label="Handoff summary" value={selected.handoff?.summary} />
                <LoopDetailLine label="Handoff reason" value={selected.handoff?.reason} />
              </div>
            </section>
          ) : (
            <p className="m-0 rounded-lg border border-dashed border-(--ui-stroke-tertiary) p-3 text-xs text-(--ui-text-tertiary)">
              No Loop rows yet. Ask Hermes to read or mutate the Loop graph.
            </p>
          )}
        </div>

        <div className="mt-3 border-t border-(--ui-stroke-tertiary) pt-3">
          <Button className="h-7 px-2 text-xs" onClick={() => setDebugOpen(value => !value)} type="button" variant="ghost">
            {debugOpen ? 'Hide debug JSON' : 'Show debug JSON'}
          </Button>
          {debugOpen && (
            <pre className="mt-2 max-h-36 overflow-auto rounded border border-(--ui-stroke-tertiary) bg-(--ui-fill-quaternary) p-2 text-[0.65rem] text-(--ui-text-secondary)">
              {state.rawJson}
            </pre>
          )}
        </div>
    </aside>
  )
}
