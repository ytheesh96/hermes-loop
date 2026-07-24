import { atom } from 'nanostores'

import { prepareTreePaneRemovalFocus, revealTreePane } from '@/components/pane-shell/tree/store'
import { sessionTitle } from '@/lib/chat-runtime'
import { readJson, writeJson } from '@/lib/storage'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { sessionPinId } from '@/store/session'
import { isSecondaryWindow } from '@/store/windows'
import type { SessionInfo } from '@/types/hermes'

export const LIVE_GRAPH_PANE_PREFIX = 'live-graph'

const STORAGE_KEY = 'hermes.desktop.liveGraphPanes.v1'

export interface LiveGraphPaneDescriptor {
  /** Stable pane-mirror key: encoded profile + logical session root. */
  key: string
  profile: string
  sessionRootId: string
  /** Current backend session id used to load this logical conversation. */
  sourceSessionId: string
  /** Chat pane this graph was opened from; closing returns focus here. */
  sourcePaneId: string
  title: string
  cwd: string
  dock: 'center' | 'right'
  /** One-sync hint used when a temporary id is promoted to its durable root. */
  replacesKey?: string
}

export interface OpenLiveGraphPaneOptions {
  dock?: 'center' | 'right'
  profile?: string
  sourcePaneId?: string
}

type StoredLiveGraphPane = Omit<LiveGraphPaneDescriptor, 'key' | 'profile' | 'replacesKey'>

const cleanString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

function cleanSourcePaneId(value: unknown): string {
  const paneId = cleanString(value)

  return paneId === 'workspace' || paneId.startsWith('session-tile:') ? paneId : 'workspace'
}

const cleanDock = (value: unknown): 'center' | 'right' => (value === 'right' ? 'right' : 'center')

export function liveGraphPaneKey(profile: string, sessionRootId: string): string {
  return `${encodeURIComponent(normalizeProfileKey(profile))}:${encodeURIComponent(sessionRootId.trim())}`
}

export function liveGraphPaneIdForDescriptor(descriptor: LiveGraphPaneDescriptor): string {
  return `${LIVE_GRAPH_PANE_PREFIX}:${descriptor.key}`
}

function decodeStoredPane(value: unknown, profile: string): LiveGraphPaneDescriptor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const raw = value as Partial<Record<keyof StoredLiveGraphPane, unknown>>
  const sessionRootId = cleanString(raw.sessionRootId)

  if (!sessionRootId) {
    return null
  }

  const sourceSessionId = cleanString(raw.sourceSessionId) || sessionRootId

  return {
    cwd: cleanString(raw.cwd),
    dock: cleanDock(raw.dock),
    key: liveGraphPaneKey(profile, sessionRootId),
    profile,
    sessionRootId,
    sourcePaneId: cleanSourcePaneId(raw.sourcePaneId),
    sourceSessionId,
    title: cleanString(raw.title) || 'Untitled session'
  }
}

function loadPanesByProfile(): Record<string, LiveGraphPaneDescriptor[]> {
  const parsed = readJson<unknown>(STORAGE_KEY)
  const result = Object.create(null) as Record<string, LiveGraphPaneDescriptor[]>

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return result
  }

  for (const [rawProfile, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value)) {
      continue
    }

    const profile = normalizeProfileKey(rawProfile)
    const byRoot = new Map<string, LiveGraphPaneDescriptor>()

    for (const item of value) {
      const pane = decodeStoredPane(item, profile)

      if (pane) {
        byRoot.set(pane.sessionRootId, pane)
      }
    }

    if (byRoot.size > 0) {
      result[profile] = [...byRoot.values()]
    }
  }

  return result
}

const panesByProfile = loadPanesByProfile()
const activeProfile = () => normalizeProfileKey($activeGatewayProfile.get())

export const $liveGraphPanes = atom<LiveGraphPaneDescriptor[]>(
  isSecondaryWindow() ? [] : [...(panesByProfile[activeProfile()] ?? [])]
)

function storedPane(descriptor: LiveGraphPaneDescriptor): StoredLiveGraphPane {
  return {
    cwd: descriptor.cwd,
    dock: descriptor.dock,
    sessionRootId: descriptor.sessionRootId,
    sourcePaneId: descriptor.sourcePaneId,
    sourceSessionId: descriptor.sourceSessionId,
    title: descriptor.title
  }
}

function persistPanes() {
  if (isSecondaryWindow()) {
    return
  }

  const stored = Object.fromEntries(
    Object.entries(panesByProfile)
      .filter(([, panes]) => panes.length > 0)
      .map(([profile, panes]) => [profile, panes.map(storedPane)])
  )

  writeJson(STORAGE_KEY, Object.keys(stored).length > 0 ? stored : null)
}

function saveProfilePanes(profile: string, panes: LiveGraphPaneDescriptor[]) {
  if (panes.length > 0) {
    panesByProfile[profile] = panes
  } else {
    delete panesByProfile[profile]
  }

  if (profile === activeProfile()) {
    $liveGraphPanes.set([...panes])
  }

  persistPanes()
}

if (!isSecondaryWindow()) {
  $activeGatewayProfile.subscribe(() => {
    $liveGraphPanes.set([...(panesByProfile[activeProfile()] ?? [])])
  })
}

function sameLogicalSession(descriptor: LiveGraphPaneDescriptor, session: SessionInfo, rootId: string): boolean {
  const identities = new Set([rootId, session.id, ...(session._lineage_ids ?? [])])

  return identities.has(descriptor.sessionRootId) || identities.has(descriptor.sourceSessionId)
}

/** Open or front exactly one native graph pane for a logical session. */
export function openLiveGraphPane(session: SessionInfo, options: OpenLiveGraphPaneOptions = {}): string {
  const profile = normalizeProfileKey(options.profile ?? session.profile ?? $activeGatewayProfile.get())
  const sessionRootId = sessionPinId(session).trim()

  if (!sessionRootId) {
    throw new Error('Cannot open Graph View without a session id')
  }

  const current = panesByProfile[profile] ?? []
  const existing = current.find(pane => sameLogicalSession(pane, session, sessionRootId))

  const descriptor: LiveGraphPaneDescriptor = {
    cwd: session.cwd?.trim() || '',
    dock: existing?.dock ?? cleanDock(options.dock),
    key: liveGraphPaneKey(profile, sessionRootId),
    profile,
    sessionRootId,
    sourcePaneId: existing?.sourcePaneId ?? cleanSourcePaneId(options.sourcePaneId),
    sourceSessionId: session.id.trim() || sessionRootId,
    title: sessionTitle(session),
    ...(existing && existing.key !== liveGraphPaneKey(profile, sessionRootId) ? { replacesKey: existing.key } : {})
  }

  const next = existing ? current.map(pane => (pane === existing ? descriptor : pane)) : [...current, descriptor]
  saveProfilePanes(profile, next)

  const paneId = liveGraphPaneIdForDescriptor(descriptor)

  if (profile === activeProfile()) {
    // The pane mirror and registry adoption are synchronous with the atom set,
    // so the exact native tab exists before this fronts it.
    revealTreePane(paneId)
  }

  return paneId
}

/** Close one graph tab and return focus to the chat pane it came from. */
export function closeLiveGraphPane(key: string): void {
  const profile = activeProfile()
  const current = panesByProfile[profile] ?? []
  const descriptor = current.find(pane => pane.key === key)

  if (!descriptor) {
    return
  }

  prepareTreePaneRemovalFocus(liveGraphPaneIdForDescriptor(descriptor), descriptor.sourcePaneId)
  saveProfilePanes(
    profile,
    current.filter(pane => pane !== descriptor)
  )
}
