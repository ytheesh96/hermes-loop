import { composerSurfaceGlass } from '@/components/chat/composer-dock'
import { StatusIndicator } from '@/components/chat/status-indicator'
import { useI18n } from '@/i18n'
import { formatModelStatusLabel } from '@/lib/model-status-label'
import { cn } from '@/lib/utils'

interface WatchComposerStatusProps {
  busy: boolean
  fast: boolean
  model: string
  provider: string
  reasoningEffort: string
}

/**
 * Loop workers are driven by their external worker process, so their watch
 * tabs must not expose an input or any mutating composer controls. Keep the
 * composer's glanceable status surface, though: the user still needs to know
 * whether the worker is active and which per-session model is doing the work.
 */
export function WatchComposerStatus({ busy, fast, model, provider, reasoningEffort }: WatchComposerStatusProps) {
  const { t } = useI18n()
  const statusLabel = busy ? t.agents.running : t.agents.done

  const modelLabel = model.trim()
    ? formatModelStatusLabel(model, { fastMode: fast, reasoningEffort })
    : t.shell.statusbar.noModel

  const visibleModelLabel = provider ? `${provider} · ${modelLabel}` : modelLabel

  const modelTitle = provider
    ? t.shell.statusbar.modelTitle(provider, model || t.shell.statusbar.modelNone)
    : modelLabel

  return (
    <div
      className={cn(
        'group/composer relative z-30 w-full shrink-0 px-4 pt-2 pb-[var(--composer-shell-pad-block-end)]',
        'bg-linear-to-b from-transparent to-background/55'
      )}
      data-slot="watch-composer-status"
      data-testid="watch-composer-status"
    >
      <div
        className="relative isolate mx-auto flex h-(--composer-fallback-height) w-[min(var(--composer-width),100%)] items-center justify-between gap-3 overflow-hidden rounded-2xl border border-[color-mix(in_srgb,var(--dt-composer-ring)_calc(18%*var(--composer-ring-strength)),var(--dt-input))] px-3"
        data-slot="composer-surface"
      >
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-0 -z-10 rounded-[inherit] bg-[color-mix(in_srgb,var(--dt-card)_72%,transparent)]',
            composerSurfaceGlass
          )}
        />
        <div
          aria-atomic="true"
          aria-live="polite"
          className="flex min-w-0 items-center gap-2 text-xs font-medium text-(--ui-text-secondary)"
          role="status"
        >
          <span aria-hidden="true">
            <StatusIndicator kind={busy ? 'active' : 'done'} />
          </span>
          <span>{statusLabel}</span>
        </div>
        <span
          className="min-w-0 truncate text-xs font-normal text-(--ui-text-tertiary)"
          data-testid="watch-composer-model"
          title={modelTitle}
        >
          {visibleModelLabel}
        </span>
      </div>
    </div>
  )
}
