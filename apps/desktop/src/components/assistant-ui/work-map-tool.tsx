import { type FC } from 'react'

import { Checkbox } from '@/components/ui/checkbox'
import { Loader2Icon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { parseWorkMap, type WorkMapItem, type WorkMapStatus } from '@/lib/work-map'

const statusGlyph: Record<WorkMapStatus, string> = {
  pending: '[ ]',
  in_progress: '[>]',
  completed: '[x]',
  cancelled: '[~]',
  blocked: '[!]'
}

function labelFor(items: readonly WorkMapItem[]): string {
  return (
    items.find(item => item.status === 'in_progress')?.content ??
    items.find(item => item.status === 'blocked')?.content ??
    items.find(item => item.status === 'pending')?.content ??
    items.at(-1)?.content ??
    'Work Map'
  )
}

const Checkmark: FC<{ item: WorkMapItem }> = ({ item }) => {
  if (item.status === 'in_progress') {
    return (
      <span
        aria-label={`In progress: ${item.content}`}
        className="grid size-[1.1rem] shrink-0 place-items-center rounded-full border border-ring/65 bg-[color-mix(in_srgb,var(--dt-ring)_14%,transparent)]"
      >
        <Loader2Icon className="size-3 animate-spin text-ring" />
      </span>
    )
  }

  const checked = item.status === 'completed'

  return (
    <Checkbox
      aria-label={item.content}
      checked={checked}
      className={cn(
        'size-[1.1rem] shrink-0 rounded-full border-border/80 pointer-events-none disabled:cursor-default disabled:opacity-100',
        checked &&
          'data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground [&_[data-slot=checkbox-indicator]_svg]:size-3',
        item.status === 'cancelled' && 'border-muted-foreground/40',
        item.status === 'blocked' && 'border-amber-500/70'
      )}
      disabled
    />
  )
}

const ItemMeta: FC<{ item: WorkMapItem }> = ({ item }) => {
  const bits: string[] = [item.kind, item.status]

  if (item.attention) {
    bits.push(item.attention)
  }

  if (item.verification_state) {
    bits.push(`verify:${item.verification_state}`)
  }

  return <span className="text-[0.65rem] text-muted-foreground">{bits.join(' · ')}</span>
}

export const HoistedWorkMapPanel: FC<{ workMap: WorkMapItem[] }> = ({ workMap }) => {
  if (!workMap.length) {
    return null
  }

  const label = labelFor(workMap)
  const ordered = [...workMap]

  return (
    <section
      className="mt-1 mb-3 inline-block w-fit max-w-full overflow-hidden rounded-2xl border border-border/70 bg-card align-top shadow-[0_1px_2px_0_hsl(var(--foreground)/0.04),0_1px_4px_-1px_hsl(var(--foreground)/0.06)]"
      data-slot="aui_work-map-hoisted"
    >
      <header className="px-3 pt-3 pb-2">
        <span className="block max-w-full truncate text-[0.85rem] font-semibold leading-tight tracking-tight text-foreground">
          Loop Work Map
        </span>
        <span className="block text-[0.65rem] uppercase tracking-wide text-muted-foreground">Hermes Loop</span>
        <span className="block max-w-full truncate text-[0.72rem] leading-tight text-muted-foreground" title={label}>
          {label}
        </span>
      </header>
      <ul className="grid min-w-0 gap-0.5 px-3 pb-3">
        {ordered.map(item => (
          <li
            className={cn(
              'flex min-w-0 items-start gap-3 py-1.5 transition-opacity',
              item.status === 'in_progress' ? 'opacity-100' : 'opacity-55'
            )}
            key={item.id}
          >
            <Checkmark item={item} />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="min-w-0 wrap-anywhere text-[0.8rem] leading-[1.2rem] text-foreground">
                  {item.content}
                </span>
                {item.dispatchable === false && (
                  <span className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">non-dispatching</span>
                )}
              </div>
              <ItemMeta item={item} />
              {item.evidence ? (
                <div className="mt-0.5 text-[0.72rem] text-muted-foreground">{item.evidence}</div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function workMapFromMessageContent(content: unknown): WorkMapItem[] {
  if (!Array.isArray(content)) {
    return []
  }

  let latest: null | WorkMapItem[] = null

  for (const part of content) {
    if (!part || typeof part !== 'object') {
      continue
    }

    const row = part as Record<string, unknown>

    if (row.type !== 'tool-call' || row.toolName !== 'work_map') {
      continue
    }

    const parsed = parseWorkMap(row.result) ?? parseWorkMap(row.args)

    if (parsed !== null) {
      latest = parsed
    }
  }

  return latest ?? []
}
