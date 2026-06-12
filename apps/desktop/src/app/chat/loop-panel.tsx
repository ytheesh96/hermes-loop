import { type CSSProperties, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
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

function rowBadge(row: LoopRow): string {
  if (row.active) {
    return 'active'
  }

  if (row.frontier) {
    return 'frontier'
  }

  return row.status
}

interface LoopRowButtonProps {
  onSelect: (row: LoopRow) => void
  row: LoopRow
  selected: boolean
}

function LoopRowButton({ onSelect, row, selected }: LoopRowButtonProps) {
  return (
    <button
      className={cn(
        'group grid w-full grid-cols-[1fr_auto] items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left text-sm transition-colors hover:border-(--ui-stroke-tertiary) hover:bg-(--ui-control-hover-background)',
        selected && 'border-(--ui-stroke-secondary) bg-(--ui-control-active-background)'
      )}
      data-testid={`loop-row-${row.taskId}`}
      onClick={() => onSelect(row)}
      style={{ '--loop-depth': row.depth, paddingLeft: `calc(0.5rem + ${row.depth} * 1rem)` } as CSSProperties}
      type="button"
    >
      <span className="min-w-0 truncate text-(--ui-text-primary)">{row.title}</span>
      <span className="rounded-full bg-(--ui-fill-quaternary) px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wide text-(--ui-text-tertiary)">
        {rowBadge(row)}
      </span>
    </button>
  )
}

export function LoopPanel({ state }: { state: LoopPanelState | null }) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [debugOpen, setDebugOpen] = useState(false)

  const selected = useMemo(() => {
    if (!state) {
      return null
    }

    return state.rows.find(row => row.taskId === selectedTaskId) || state.rows[0] || null
  }, [selectedTaskId, state])

  if (!state) {
    return null
  }

  return (
    <aside className="hidden w-80 shrink-0 border-l border-(--ui-stroke-secondary) bg-(--ui-sidebar-background) p-3 text-(--ui-text-secondary) xl:flex xl:flex-col">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="m-0 text-sm font-semibold text-(--ui-text-primary)">Loop</h2>
          <p className="m-0 mt-0.5 text-xs text-(--ui-text-tertiary)">
            {statusCopy(state.status)} · rev {state.revision || '—'}
          </p>
        </div>
        {state.rootTaskId && (
          <span className="rounded bg-(--ui-fill-quaternary) px-1.5 py-0.5 font-mono text-[0.65rem] text-(--ui-text-tertiary)">
            {state.rootTaskId}
          </span>
        )}
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
        {state.rows.length ? (
          <div className="grid gap-1">
            {state.rows.map(row => (
              <LoopRowButton
                key={row.taskId}
                onSelect={row => setSelectedTaskId(row.taskId)}
                row={row}
                selected={selected?.taskId === row.taskId}
              />
            ))}
          </div>
        ) : (
          <p className="m-0 rounded-lg border border-dashed border-(--ui-stroke-tertiary) p-3 text-xs text-(--ui-text-tertiary)">
            No triage-backed draft rows yet. Ask Hermes to read or mutate the Loop graph.
          </p>
        )}
      </div>

      {selected && (
        <section className="mt-3 rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-surface-background) p-3 text-xs">
          <h3 className="m-0 mb-2 text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)">
            Draft task details
          </h3>
          <div className="grid gap-1.5">
            <div className="font-medium text-(--ui-text-primary)">{selected.title}</div>
            <div className="font-mono text-(--ui-text-tertiary)">{selected.taskId}</div>
            <div>Status: {selected.status}</div>
            <div>Parents: {selected.parents.length ? selected.parents.join(', ') : 'none'}</div>
          </div>
        </section>
      )}

      <div className="mt-3 border-t border-(--ui-stroke-tertiary) pt-3">
        <Button className="h-7 px-2 text-xs" onClick={() => setDebugOpen(open => !open)} type="button" variant="ghost">
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
