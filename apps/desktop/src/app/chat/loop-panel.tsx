import { type CSSProperties, useMemo, useState } from 'react'

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

function statusIndicatorClass(status: string): string {
  const value = status.toLowerCase()

  if (value === 'running' || value === 'in_progress' || value === 'claimed') {
    return 'size-1.5 bg-(--ui-accent) shadow-[0_0_0.625rem_color-mix(in_srgb,var(--ui-accent)_45%,transparent)]'
  }

  if (value === 'blocked' || value === 'stale') {
    return 'size-1.5 bg-amber-500'
  }

  if (value === 'error' || value === 'failed') {
    return 'size-1.5 bg-destructive'
  }

  if (value === 'done') {
    return 'size-1.5 bg-emerald-500/80'
  }

  return 'size-1 bg-(--ui-text-quaternary) opacity-80'
}

function LoopStatusIndicator({ row }: { row: LoopRow }) {
  return (
    <span
      aria-label={`Status: ${row.status}`}
      className="grid w-3.5 shrink-0 place-items-center overflow-hidden"
      role="img"
    >
      <span aria-hidden="true" className={cn('rounded-full', statusIndicatorClass(row.status))} />
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
  onSelect: (row: LoopRow) => void
  row: LoopRow
  selected: boolean
}

function LoopStackRow({ onSelect, row, selected }: LoopStackRowProps) {
  return (
    <div
      data-testid={`loop-card-${row.taskId}`}
      style={{ '--loop-depth': row.depth, paddingLeft: `calc(0.5rem + ${row.depth} * 1rem)` } as CSSProperties}
    >
      <StatusRow
        className={cn(selected && 'bg-(--ui-row-hover-background)')}
        leading={<LoopStatusIndicator row={row} />}
        onActivate={() => onSelect(row)}
      >
        <span
          className={cn(
            'min-w-0 max-w-[18rem] truncate text-[0.73rem] leading-4',
            row.active || row.frontier ? 'font-medium text-foreground/92' : selected ? 'text-foreground/92' : 'text-muted-foreground/75'
          )}
        >
          {row.title}
          {(row.parentCount > 0 || row.childCount > 0) && (
            <span className="ml-1 text-[0.65rem] font-normal text-(--ui-text-quaternary)">
              {row.parentCount}↑/{row.childCount}↓
            </span>
          )}
        </span>
      </StatusRow>
    </div>
  )
}

interface LoopTaskStackProps {
  onSelectTask: (row: LoopRow) => void
  selectedTaskId?: null | string
  state: LoopPanelState | null
}

export function LoopTaskStack({ onSelectTask, selectedTaskId, state }: LoopTaskStackProps) {
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
          onSelect={onSelectTask}
          row={row}
          selected={selected?.taskId === row.taskId}
        />
      ))}
    </StatusSection>
  )
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
                <div className="font-mono text-(--ui-text-tertiary)">{selected.taskId}</div>
                <div>Parents: {selected.parents.length ? selected.parents.join(', ') : 'none'}</div>
                <div>Links: {selected.parentCount} parents · {selected.childCount} children</div>
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
