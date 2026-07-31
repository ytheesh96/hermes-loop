import { type ReactNode } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import { cn } from '@/lib/utils'

export type StatusIndicatorKind = 'active' | 'attention' | 'done' | 'failed' | 'pending' | 'triage' | 'unknown'

interface StatusIndicatorProps {
  ariaLabel?: string
  className?: string
  kind: StatusIndicatorKind
}

function statusGlyph(kind: StatusIndicatorKind, ariaLabel?: string): ReactNode {
  switch (kind) {
    case 'triage':
      return (
        <span
          aria-hidden="true"
          className="box-border size-[0.7rem] rounded-full border border-dashed border-muted-foreground/60"
        />
      )

    case 'pending':
      return <Codicon aria-hidden="true" className="text-muted-foreground/40" name="pass-filled" size="0.8rem" />

    case 'active':
      return (
        <GlyphSpinner
          ariaLabel={ariaLabel || 'Running'}
          className="text-[0.9rem] leading-none text-muted-foreground/80"
          spinner="braille"
        />
      )

    case 'done':
      return <Codicon aria-hidden="true" className="text-emerald-500/80" name="pass-filled" size="0.8rem" />

    case 'failed':
      return <Codicon aria-hidden="true" className="text-destructive/70" name="circle-slash" size="0.8rem" />

    case 'attention':
      return <Codicon aria-hidden="true" className="text-amber-500/80" name="warning" size="0.8rem" />

    case 'unknown':

    default:
      return <Codicon aria-hidden="true" className="text-muted-foreground/40" name="question" size="0.8rem" />
  }
}

export function StatusIndicator({ ariaLabel, className, kind }: StatusIndicatorProps) {
  return (
    <span
      aria-label={ariaLabel}
      className={cn('grid size-3.5 shrink-0 place-items-center overflow-hidden', className)}
      role={ariaLabel ? 'img' : undefined}
    >
      {statusGlyph(kind, ariaLabel)}
    </span>
  )
}
