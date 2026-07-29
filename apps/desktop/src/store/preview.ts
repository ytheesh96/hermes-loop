import { atom, computed } from 'nanostores'

import { persistentAtom } from '@/lib/persisted'
import { normalize } from '@/lib/text'

import { $rightRailActiveTabId, PREVIEW_PANE_ID, type RightRailTabId, selectRightRailTab } from './layout'
import { setPaneOpen } from './panes'

/**
 * PREVIEW RAIL — one list of tabs, one way in.
 *
 * Everything the rail can show is a `PreviewTarget` in `$previewTabs`: a file
 * on disk, a live URL, or a generated artifact. There is no privileged "live
 * preview" slot alongside the tabs; `openPreview` is the only entry point, so
 * a tool result, a file-browser click, and an artifact card all travel the
 * same road and behave identically once open.
 *
 * Tabs are global and outlive the session that created them, like tabs
 * anywhere else — they close when you close them.
 */

export interface PreviewTarget {
  binary?: boolean
  byteSize?: number
  /** Inline image bytes (a `data:` URL) when the renderer already holds them —
   * e.g. a pasted/dropped screenshot whose only on-disk copy is a transient
   * path the preview can't reliably re-read. Rendered directly and NOT
   * persisted (it would bloat localStorage). */
  dataUrl?: string
  /** `artifact` targets have nothing behind them on disk or on the network —
   * `url` is an id into the artifact registry, which owns the content. */
  kind: 'artifact' | 'file' | 'url'
  label: string
  large?: boolean
  language?: string
  mimeType?: string
  path?: string
  previewKind?: 'binary' | 'html' | 'image' | 'text'
  renderMode?: 'preview' | 'source'
  source: string
  url: string
}

export interface PreviewServerRestart {
  message?: string
  status: 'complete' | 'error' | 'running'
  taskId: string
  url: string
}

/** Where an open came from. Only affects how an HTML file is first rendered. */
export type PreviewRecordSource = 'explicit-link' | 'file-browser' | 'manual' | 'tool-result'
export type PreviewOpenMode = 'preview' | 'source'

export interface PreviewOpenOptions {
  mode?: PreviewOpenMode
}

export interface PreviewTab {
  id: RightRailTabId
  target: PreviewTarget
}

const TABS_STORAGE_KEY = 'hermes.desktop.previewTabs.v2'
/** Superseded by the unified tab list; cleared so it cannot leak forever. */
const LEGACY_SESSION_REGISTRY_KEY = 'hermes.desktop.sessionPreviews.v1'

function isPreviewTarget(value: unknown): value is PreviewTarget {
  if (!value || typeof value !== 'object') {
    return false
  }

  const row = value as Record<string, unknown>

  return (
    (row.kind === 'artifact' || row.kind === 'file' || row.kind === 'url') &&
    typeof row.label === 'string' &&
    typeof row.source === 'string' &&
    typeof row.url === 'string'
  )
}

// Artifact tabs are never written (their registry is memory-only), so a
// restored artifact row is stale storage.
function isPreviewTab(value: unknown): value is PreviewTab {
  if (!value || typeof value !== 'object') {
    return false
  }

  const row = value as Record<string, unknown>

  return (
    typeof row.id === 'string' &&
    (row.id.startsWith('file:') || row.id.startsWith('url:')) &&
    isPreviewTarget(row.target)
  )
}

export const $previewTabs = persistentAtom<PreviewTab[]>(TABS_STORAGE_KEY, [], {
  decode: raw => {
    const parsed = JSON.parse(raw) as unknown

    return Array.isArray(parsed) ? parsed.filter(isPreviewTab) : []
  },
  // Inline image bytes are stripped, and memory-only artifacts are skipped.
  encode: tabs =>
    JSON.stringify(
      tabs.filter(tab => tab.target.kind !== 'artifact'),
      (key, value) => (key === 'dataUrl' ? undefined : value)
    )
})

if (typeof window !== 'undefined') {
  try {
    window.localStorage.removeItem(LEGACY_SESSION_REGISTRY_KEY)
  } catch {
    // Storage access can throw in locked-down contexts; nothing depends on it.
  }
}

/** Resolve the rail's visible tab, falling back when selection is stale. */
function resolveActiveTab(tabs: PreviewTab[], activeTabId: RightRailTabId | null): PreviewTab | null {
  return tabs.find(tab => tab.id === activeTabId) ?? tabs[0] ?? null
}

function activePreviewTab(): PreviewTab | null {
  return resolveActiveTab($previewTabs.get(), $rightRailActiveTabId.get())
}

selectRightRailTab(activePreviewTab()?.id ?? null)

export const $previewTarget = computed(
  [$previewTabs, $rightRailActiveTabId],
  (tabs, activeTabId) => resolveActiveTab(tabs, activeTabId)?.target ?? null
)

/** Raw sources for composer rows that toggle previews by their input target. */
export const $previewTabSources = computed($previewTabs, tabs => tabs.map(tab => tab.target.source))

export const $previewReloadRequest = atom(0)
/** Bumped on every open so an existing tab also reveals a hidden pane. */
export const $previewOpenRequest = atom(0)
export const $previewServerRestart = atom<PreviewServerRestart | null>(null)
export const $previewServerRestartStatus = computed($previewServerRestart, restart => restart?.status ?? 'idle')

export function previewTabId(target: PreviewTarget): RightRailTabId {
  return `${target.kind}:${target.url}`
}

function isFilePreviewSource(source: PreviewRecordSource): boolean {
  return source === 'file-browser' || source === 'manual'
}

function previewTargetForSource(
  target: PreviewTarget,
  source: PreviewRecordSource,
  options: PreviewOpenOptions
): PreviewTarget {
  if (target.kind !== 'file' || target.previewKind !== 'html') {
    return target
  }

  return { ...target, renderMode: options.mode ?? (isFilePreviewSource(source) ? 'source' : 'preview') }
}

/** The only preview entry point. `mode` lets an explicit user choice override
 * the source-derived HTML default without creating a second tab architecture. */
export function openPreview(
  target: PreviewTarget,
  source: PreviewRecordSource = 'manual',
  options: PreviewOpenOptions = {}
) {
  const resolved = previewTargetForSource(target, source, options)
  const id = previewTabId(resolved)
  const current = $previewTabs.get()
  const index = current.findIndex(tab => tab.id === id)
  const tab: PreviewTab = { id, target: resolved }

  $previewTabs.set(index === -1 ? [...current, tab] : current.map((item, i) => (i === index ? tab : item)))
  setPaneOpen(PREVIEW_PANE_ID, true)
  selectRightRailTab(id)
  $previewOpenRequest.set($previewOpenRequest.get() + 1)
}

export function closeRightRailTab(tabId: RightRailTabId) {
  const current = $previewTabs.get()
  const index = current.findIndex(tab => tab.id === tabId)

  if (index === -1) {
    return
  }

  const next = current.filter(tab => tab.id !== tabId)

  $previewTabs.set(next)

  if ($rightRailActiveTabId.get() === tabId) {
    selectRightRailTab(next[Math.min(index, next.length - 1)]?.id ?? null)
  }

  if (next.length === 0) {
    setPaneOpen(PREVIEW_PANE_ID, false)
  }
}

/** Close the tab showing `source`, if one is open. */
export function closePreviewForSource(source: string): boolean {
  const tab = $previewTabs.get().find(item => item.target.source === source)

  if (!tab) {
    return false
  }

  closeRightRailTab(tab.id)

  return true
}

/** Artifact tabs cannot outlive the in-memory registry they read from. */
export function closeArtifactPreviewTabs() {
  for (const tab of $previewTabs.get()) {
    if (tab.target.kind === 'artifact') {
      closeRightRailTab(tab.id)
    }
  }
}

export function closeActiveRightRailTab(): boolean {
  const tab = activePreviewTab()

  if (!tab) {
    return false
  }

  closeRightRailTab(tab.id)

  return true
}

export function closeOtherRightRailTabs(keepId: RightRailTabId) {
  for (const tab of $previewTabs.get()) {
    if (tab.id !== keepId) {
      closeRightRailTab(tab.id)
    }
  }

  selectRightRailTab(keepId)
}

export function closeRightRailTabsToRight(tabId: RightRailTabId) {
  const tabs = $previewTabs.get()
  const index = tabs.findIndex(tab => tab.id === tabId)

  if (index === -1) {
    return
  }

  for (const tab of tabs.slice(index + 1)) {
    closeRightRailTab(tab.id)
  }
}

export function closeRightRail() {
  $previewTabs.set([])
  selectRightRailTab(null)
  setPaneOpen(PREVIEW_PANE_ID, false)
}

/** Compatibility shims for the fork's embedded work-rail caller. Both route
 * through the unified tab store; no session registry or privileged slot remains. */
export function setPreviewTarget(target: PreviewTarget | null) {
  if (target) {
    openPreview(target)
  } else {
    closeRightRail()
  }
}

export function clearSessionPreviewRegistry() {
  closeRightRail()
}

export function requestPreviewReload() {
  $previewReloadRequest.set($previewReloadRequest.get() + 1)
}

export function beginPreviewServerRestart(taskId: string, url: string) {
  $previewServerRestart.set({ status: 'running', taskId, url })
}

export function completePreviewServerRestart(taskId: string, text: string) {
  const current = $previewServerRestart.get()

  if (current?.taskId !== taskId) {
    return
  }

  $previewServerRestart.set({
    ...current,
    message: text,
    status: normalize(text).startsWith('error:') ? 'error' : 'complete'
  })
}

export function progressPreviewServerRestart(taskId: string, text: string) {
  const current = $previewServerRestart.get()

  if (current?.taskId !== taskId || current.status !== 'running') {
    return
  }

  $previewServerRestart.set({
    ...current,
    message: text
  })
}

export function failPreviewServerRestart(taskId: string, message: string) {
  const current = $previewServerRestart.get()

  if (current?.taskId !== taskId || current.status !== 'running') {
    return
  }

  $previewServerRestart.set({
    ...current,
    message,
    status: 'error'
  })
}
