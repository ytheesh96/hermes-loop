import { useStore } from '@nanostores/react'
import { useMemo, useState, type ReactNode } from 'react'

import { loopConnectedTaskIds, type LoopPanelState, type LoopRow } from '@/app/chat/loop-state'
import { ErrorBoundary } from '@/components/error-boundary'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { DisclosureCaret } from '@/components/ui/disclosure-caret'
import { Loader } from '@/components/ui/loader'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { selectDesktopPaths } from '@/lib/desktop-fs'
import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { cn } from '@/lib/utils'
import { $panesFlipped } from '@/store/layout'
import { notifyError } from '@/store/notifications'
import { type PreviewOpenMode, setCurrentSessionPreviewTarget } from '@/store/preview'
import { $currentCwd } from '@/store/session'

import { SidebarPanelLabel } from '../shell/sidebar-label'

import { RemoteFolderPicker } from './files/remote-picker'
import { ProjectTree } from './files/tree'
import { useProjectTree, type TreeNode } from './files/use-project-tree'

interface RightSidebarPaneProps {
  loopFocusedTaskId?: null | string
  loopState?: LoopPanelState | null
  onActivateFile: (path: string) => void
  onActivateFolder: (path: string) => void
  onChangeCwd: (path: string) => Promise<void> | void
}

export function RightSidebarPane({
  loopFocusedTaskId,
  loopState,
  onActivateFile,
  onActivateFolder,
  onChangeCwd
}: RightSidebarPaneProps) {
  const { t } = useI18n()
  const r = t.rightSidebar
  const panesFlipped = useStore($panesFlipped)
  const currentCwd = useStore($currentCwd).trim()
  const hasCwd = currentCwd.length > 0
  const [changedFilesOpen, setChangedFilesOpen] = useState(true)
  const [changedFilesView, setChangedFilesView] = useState<ChangedFilesView>('tree')
  const [fileExplorerOpen, setFileExplorerOpen] = useState(true)

  const {
    collapseAll,
    collapseNonce,
    data,
    effectiveCwd,
    loadChildren,
    openState,
    refreshRoot,
    rootError,
    rootLoading,
    setNodeOpen
  } = useProjectTree(currentCwd)

  const cwdName = hasCwd
    ? (effectiveCwd
        .split(/[\\/]+/)
        .filter(Boolean)
        .pop() ?? effectiveCwd)
    : r.noFolderSelected

  const canCollapse = Object.values(openState).some(Boolean)
  const changedFilesScopeTaskIds = changedFilesTaskScope(loopState, loopFocusedTaskId)
  const changedFiles = useMemo(
    () => changedFilesFromLoopState(loopState, changedFilesScopeTaskIds),
    [changedFilesScopeTaskIds, loopState]
  )

  const chooseFolder = async () => {
    const selected = await selectDesktopPaths({
      defaultPath: hasCwd ? effectiveCwd : undefined,
      directories: true,
      multiple: false,
      title: r.changeCwdTitle
    })

    if (selected?.[0]) {
      await onChangeCwd(selected[0])
    }
  }

  const previewFile = async (path: string, mode?: PreviewOpenMode) => {
    try {
      const preview = await normalizeOrLocalPreviewTarget(path, effectiveCwd || undefined)

      if (!preview) {
        throw new Error(r.couldNotPreview(path))
      }

      setCurrentSessionPreviewTarget(preview, 'file-browser', path, {
        mode: mode ?? (preview.previewKind === 'html' ? 'preview' : 'source')
      })
    } catch (error) {
      notifyError(error, r.previewUnavailable)
    }
  }

  return (
    <aside
      aria-label={r.aria}
      className={cn(
        'before:pointer-events-none relative flex h-full w-full min-w-0 flex-col overflow-hidden border-(--ui-stroke-secondary) bg-(--ui-sidebar-surface-background) pt-(--titlebar-height) text-(--ui-text-tertiary)',
        panesFlipped
          ? 'border-r shadow-[inset_-0.0625rem_0_0_color-mix(in_srgb,white_18%,transparent)]'
          : 'border-l shadow-[inset_0.0625rem_0_0_color-mix(in_srgb,white_18%,transparent)]'
      )}
    >
      <RemoteFolderPicker />

      <FilesystemTab
        canCollapse={canCollapse}
        collapseNonce={collapseNonce}
        cwd={effectiveCwd}
        cwdName={cwdName}
        data={data}
        error={rootError}
        hasCwd={hasCwd}
        loading={rootLoading}
        onActivateFile={onActivateFile}
        onActivateFolder={onActivateFolder}
        onChangeFolder={chooseFolder}
        onCollapseAll={collapseAll}
        onOpenChange={setFileExplorerOpen}
        onLoadChildren={loadChildren}
        onNodeOpenChange={setNodeOpen}
        onPreviewFile={previewFile}
        onRefresh={() => void refreshRoot()}
        onViewSourceFile={path => void previewFile(path, 'source')}
        open={fileExplorerOpen}
        openState={openState}
      />

      <ChangedFilesSection
        entries={changedFiles}
        fillAvailable={!fileExplorerOpen}
        onActivateFile={onActivateFile}
        onOpenChange={setChangedFilesOpen}
        onPreviewFile={path => void previewFile(path, 'source')}
        onViewChange={setChangedFilesView}
        open={changedFilesOpen}
        view={changedFilesView}
      />
    </aside>
  )
}

type ChangedFileStatus = 'A' | 'D' | 'M'
type ChangedFilesView = 'tree' | 'list'

interface ChangedFileEntry {
  absolutePath: string
  id: string
  name: string
  relativePath: string
  status: ChangedFileStatus
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function changedFileMetadataSources(row: LoopRow): unknown[] {
  const sources = [
    row.latestRun?.metadata,
    ...(row.workerActivity?.recent_task_events || [])
      .slice()
      .reverse()
      .map(event => event.payload)
  ]

  return sources.flatMap(source => {
    const nested = isRecord(source) ? source.metadata : null

    return nested ? [source, nested] : [source]
  })
}

function changedFileValues(metadata: unknown): unknown[] {
  if (!isRecord(metadata)) {
    return []
  }

  const values = metadata.changed_files ?? metadata.changedFiles

  if (Array.isArray(values)) {
    return values
  }

  return values ? [values] : []
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function changedFilePath(value: unknown): string {
  if (typeof value === 'string') {
    return parseChangedFileString(value).path
  }

  if (!isRecord(value)) {
    return ''
  }

  for (const key of ['path', 'file', 'filepath', 'target', 'source']) {
    const candidate = textValue(value[key])

    if (candidate) {
      return candidate
    }
  }

  return ''
}

function statusFromText(value: string): ChangedFileStatus {
  const normalized = value.trim().toLowerCase()

  if (/^(a|add|added|new|create|created|untracked|\?\?)$/.test(normalized)) {
    return 'A'
  }

  if (/^(d|delete|deleted|remove|removed)$/.test(normalized)) {
    return 'D'
  }

  return 'M'
}

function parseChangedFileString(value: string): { path: string; status: ChangedFileStatus } {
  const trimmed = value.trim()
  const porcelain = trimmed.match(/^([ MADRCU?!]{1,2})\s+(.+)$/)

  if (!porcelain) {
    return { path: trimmed, status: 'M' }
  }

  const rawStatus = porcelain[1]!.trim()
  const rawPath = porcelain[2]!.replace(/^.+\s+->\s+/, '').trim()

  return { path: rawPath, status: statusFromText(rawStatus) }
}

function changedFileStatus(value: unknown): ChangedFileStatus {
  if (typeof value === 'string') {
    return parseChangedFileString(value).status
  }

  if (!isRecord(value)) {
    return 'M'
  }

  for (const key of ['status', 'change', 'change_type', 'changeType', 'kind']) {
    const candidate = textValue(value[key])

    if (candidate) {
      return statusFromText(candidate)
    }
  }

  const diff = textValue(value.inline_diff) || textValue(value.inlineDiff) || textValue(value.diff)

  if (/\bdeleted file mode\b/.test(diff)) {
    return 'D'
  }

  if (/\bnew file mode\b/.test(diff)) {
    return 'A'
  }

  return 'M'
}

function isAbsolutePath(value: string): boolean {
  return /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(value)
}

function isUrlTarget(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value)
}

function joinPath(base: string, target: string): string {
  if (!base) {
    return target
  }

  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/'

  return `${base.replace(/[\\/]+$/, '')}${separator}${target.replace(/^\.?[\\/]+/, '')}`
}

function normalizeRelativePath(target: string): string {
  return target.replace(/^[\\/]+/, '').replace(/\\/g, '/')
}

function changedFilesTaskScope(loopState?: LoopPanelState | null, focusedTaskId?: null | string): string[] {
  if (!loopState) {
    return []
  }

  const taskId = focusedTaskId?.trim() || loopState.rootTaskId

  if (!taskId || taskId === loopState.rootTaskId) {
    return loopConnectedTaskIds(loopState, loopState.rootTaskId)
  }

  return [taskId]
}

function changedFilesFromLoopState(
  loopState?: LoopPanelState | null,
  taskScopeIds?: readonly string[] | null
): ChangedFileEntry[] {
  const entries: ChangedFileEntry[] = []
  const taskIds = new Set(taskScopeIds || [])
  const rows = taskIds.size > 0 ? (loopState?.rows || []).filter(row => taskIds.has(row.taskId)) : []
  let nextEntryId = 0

  for (const row of rows) {
    for (const metadata of changedFileMetadataSources(row)) {
      for (const value of changedFileValues(metadata)) {
        const rawPath = changedFilePath(value)

        if (!rawPath) {
          continue
        }

        const status = changedFileStatus(value)
        const absolutePath =
          isUrlTarget(rawPath) || isAbsolutePath(rawPath) ? rawPath : joinPath(row.workspacePath || '', rawPath)
        const relativePath = normalizeRelativePath(rawPath)
        const parts = relativePath.split('/').filter(Boolean)
        const name = parts.pop() || relativePath

        entries.push({
          absolutePath,
          id: `${row.taskId}:${nextEntryId++}:${absolutePath || rawPath}`,
          name,
          relativePath,
          status
        })
      }
    }
  }

  return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

function changedFileTreeFromEntries(entries: ChangedFileEntry[]): {
  badgeByNodeId: Map<string, ChangedFileStatus>
  data: TreeNode[]
  openState: Record<string, boolean>
  statusByPath: Map<string, ChangedFileStatus>
} {
  const rootNodes: TreeNode[] = []
  const directories = new Map<string, TreeNode>()
  const badgeByNodeId = new Map<string, ChangedFileStatus>()
  const openState: Record<string, boolean> = {}
  const statusByPath = new Map<string, ChangedFileStatus>()

  const directoryNode = (parts: string[]): TreeNode => {
    const key = parts.join('/')
    const existing = directories.get(key)

    if (existing) {
      return existing
    }

    const node: TreeNode = {
      children: [],
      id: `changed:${key}`,
      isDirectory: true,
      name: parts.at(-1) || key
    }

    directories.set(key, node)
    openState[node.id] = true

    if (parts.length === 1) {
      rootNodes.push(node)
    } else {
      directoryNode(parts.slice(0, -1)).children!.push(node)
    }

    return node
  }

  for (const entry of entries) {
    const parts = entry.relativePath.split('/').filter(Boolean)
    const fileName = parts.pop() || entry.name
    const fileNode: TreeNode = {
      id: entry.id,
      isDirectory: false,
      name: fileName,
      path: entry.absolutePath || entry.relativePath
    }

    badgeByNodeId.set(fileNode.id, entry.status)
    statusByPath.set(fileNode.path || fileNode.id, entry.status)

    if (parts.length === 0) {
      rootNodes.push(fileNode)
    } else {
      directoryNode(parts).children!.push(fileNode)
    }
  }

  return { badgeByNodeId, data: rootNodes, openState, statusByPath }
}

function changedFileFlatTreeFromEntries(entries: ChangedFileEntry[]): {
  badgeByNodeId: Map<string, ChangedFileStatus>
  data: TreeNode[]
  openState: Record<string, boolean>
  statusByPath: Map<string, ChangedFileStatus>
} {
  const badgeByNodeId = new Map<string, ChangedFileStatus>()
  const statusByPath = new Map<string, ChangedFileStatus>()

  return {
    badgeByNodeId,
    data: entries.map(entry => {
      const path = entry.absolutePath || entry.relativePath

      badgeByNodeId.set(entry.id, entry.status)
      statusByPath.set(path, entry.status)

      return {
        id: entry.id,
        isDirectory: false,
        name: entry.name,
        path
      }
    }),
    openState: {},
    statusByPath
  }
}

function ChangedFilesSection({
  entries,
  fillAvailable,
  onActivateFile,
  onOpenChange,
  onPreviewFile,
  onViewChange,
  open,
  view
}: {
  entries: ChangedFileEntry[]
  fillAvailable: boolean
  onActivateFile: (path: string) => void
  onOpenChange: (open: boolean) => void
  onPreviewFile: (path: string) => void
  onViewChange: (view: ChangedFilesView) => void
  open: boolean
  view: ChangedFilesView
}) {
  if (entries.length === 0) {
    return null
  }

  const showingTree = view === 'tree'
  const { badgeByNodeId, data, openState, statusByPath } = showingTree
    ? changedFileTreeFromEntries(entries)
    : changedFileFlatTreeFromEntries(entries)
  const nextView = showingTree ? 'list' : 'tree'
  const viewToggleLabel = showingTree ? 'Show changed files as flat list' : 'Show changed files as file tree'
  const openChangedFile = (path: string) => {
    if (statusByPath.get(path) !== 'D') {
      onPreviewFile(path)
    }
  }
  const attachChangedFile = (path: string) => {
    if (statusByPath.get(path) !== 'D') {
      onActivateFile(path)
    }
  }

  return (
    <section
      aria-label="Changed files"
      className={cn(
        'relative flex w-full min-w-0 shrink-0 flex-col overflow-hidden p-0 pb-1',
        open && (fillAvailable ? 'min-h-0 flex-1' : 'min-h-40 basis-[22rem] max-h-[50%]')
      )}
      data-testid="right-sidebar-changed-files"
    >
      <RightSidebarSectionHeader
        label="Changed files"
        meta={entries.length}
        onToggle={() => onOpenChange(!open)}
        open={open}
      >
        <div className="grid size-6 shrink-0 place-items-center">
          <Tip label={viewToggleLabel}>
            <Button
              aria-label={viewToggleLabel}
              className="text-(--ui-text-tertiary) opacity-70 hover:bg-(--ui-control-hover-background) hover:text-foreground hover:opacity-100 focus-visible:opacity-100"
              onClick={event => {
                event.stopPropagation()
                onViewChange(nextView)
              }}
              size="icon-xs"
              variant="ghost"
            >
              <Codicon name={showingTree ? 'list-unordered' : 'list-tree'} size="0.75rem" />
            </Button>
          </Tip>
        </div>
      </RightSidebarSectionHeader>
      {open && (
        <ProjectTree
          collapseNonce={0}
          cwd={`loop-changed-files:${view}`}
          data={data}
          getFileBadge={node => {
            const badge = badgeByNodeId.get(node.id)

            return badge ? (
              <span aria-hidden className="font-mono text-[0.62rem] text-(--ui-text-quaternary)">
                {badge}
              </span>
            ) : null
          }}
          onActivateFile={attachChangedFile}
          onActivateFolder={() => undefined}
          onLoadChildren={() => undefined}
          onNodeOpenChange={() => undefined}
          onPreviewFile={openChangedFile}
          openState={openState}
        />
      )}
    </section>
  )
}

interface FilesystemTabProps extends FileTreeBodyProps {
  canCollapse: boolean
  cwdName: string
  hasCwd: boolean
  onChangeFolder: () => Promise<void> | void
  onCollapseAll: () => void
  onOpenChange: (open: boolean) => void
  onRefresh: () => void
  open: boolean
}

// Sidebar palette + hover-reveal: header actions stay reachable while moving
// from the project label to the action buttons.
const HEADER_ACTION_CLASS =
  'text-sidebar-foreground/70 hover:bg-sidebar-accent! hover:text-sidebar-accent-foreground! focus-visible:ring-sidebar-ring'

const HEADER_ACTION_LABEL_REVEAL = `${HEADER_ACTION_CLASS} pointer-events-none opacity-0 transition-opacity focus-visible:pointer-events-auto focus-visible:opacity-100 group-focus-within/project-header:pointer-events-auto group-focus-within/project-header:opacity-100 group-hover/project-header:pointer-events-auto group-hover/project-header:opacity-100`

function FilesystemTab({
  canCollapse,
  collapseNonce,
  cwd,
  cwdName,
  data,
  error,
  hasCwd,
  loading,
  onActivateFile,
  onActivateFolder,
  onChangeFolder,
  onCollapseAll,
  onOpenChange,
  onLoadChildren,
  onNodeOpenChange,
  onPreviewFile,
  onRefresh,
  open,
  openState
}: FilesystemTabProps) {
  const { t } = useI18n()
  const r = t.rightSidebar

  return (
    <div
      className={cn('relative flex min-h-0 w-full min-w-0 flex-col overflow-hidden p-0', open ? 'flex-1' : 'shrink-0')}
    >
      <RightSidebarSectionHeader label={cwdName} onToggle={() => onOpenChange(!open)} open={open}>
        <Button
          aria-label={r.refreshTree}
          className={HEADER_ACTION_LABEL_REVEAL}
          disabled={!hasCwd || loading}
          onClick={onRefresh}
          size="icon-xs"
          variant="ghost"
        >
          <Codicon name="refresh" size="0.8125rem" spinning={loading} />
        </Button>
        <Button
          aria-label={r.openFolder}
          className={HEADER_ACTION_CLASS}
          onClick={() => void onChangeFolder()}
          size="icon-xs"
          variant="ghost"
        >
          <Codicon name="folder-opened" size="0.8125rem" />
        </Button>
        <Button
          aria-label={r.collapseAll}
          className={cn(HEADER_ACTION_CLASS, !canCollapse && 'pointer-events-none opacity-0')}
          disabled={!hasCwd || !canCollapse}
          onClick={onCollapseAll}
          size="icon-xs"
          variant="ghost"
        >
          <Codicon name="collapse-all" size="0.8125rem" />
        </Button>
      </RightSidebarSectionHeader>
      {open && (
        <FileTreeBody
          collapseNonce={collapseNonce}
          cwd={cwd}
          data={data}
          error={error}
          loading={loading}
          onActivateFile={onActivateFile}
          onActivateFolder={onActivateFolder}
          onLoadChildren={onLoadChildren}
          onNodeOpenChange={onNodeOpenChange}
          onPreviewFile={onPreviewFile}
          onRetry={onRefresh}
          openState={openState}
        />
      )}
    </div>
  )
}

export function RightSidebarSectionHeader({
  children,
  label,
  meta,
  onToggle,
  open
}: {
  children?: ReactNode
  label: ReactNode
  meta?: ReactNode
  onToggle: () => void
  open: boolean
}) {
  return (
    <div className="group/project-header group/section flex w-full min-w-0 shrink-0 items-center pb-1 pt-1.5">
      <button
        aria-expanded={open}
        className="group/section-label flex min-w-0 shrink items-center gap-1 bg-transparent text-left leading-none"
        onClick={onToggle}
        type="button"
      >
        <SidebarPanelLabel>{label}</SidebarPanelLabel>
        {meta != null && <RightSidebarCount>{meta}</RightSidebarCount>}
        <DisclosureCaret
          className="text-(--ui-text-tertiary) opacity-0 transition group-hover/section-label:opacity-100"
          open={open}
        />
      </button>
      {children && <div className="ml-auto flex shrink-0 items-center">{children}</div>}
    </div>
  )
}

function RightSidebarCount({ children }: { children: ReactNode }) {
  return <span className="text-[0.6875rem] font-medium text-(--ui-text-quaternary)">{children}</span>
}

interface FileTreeBodyProps {
  collapseNonce: number
  cwd: string
  data: ReturnType<typeof useProjectTree>['data']
  error: string | null
  loading: boolean
  onActivateFile: (path: string) => void
  onActivateFolder: (path: string) => void
  onLoadChildren: (id: string) => void | Promise<void>
  onNodeOpenChange: (id: string, open: boolean) => void
  onPreviewFile?: (path: string) => void
  /** Force-reload the root. The hook also auto-retries while errored, so this
   *  is the impatient-user path. */
  onRetry?: () => void
  onViewSourceFile?: (path: string) => void
  openState: ReturnType<typeof useProjectTree>['openState']
}

function FileTreeBody({
  collapseNonce,
  cwd,
  data,
  error,
  loading,
  onActivateFile,
  onActivateFolder,
  onLoadChildren,
  onNodeOpenChange,
  onPreviewFile,
  onRetry,
  onViewSourceFile,
  openState
}: FileTreeBodyProps) {
  const { t } = useI18n()
  const r = t.rightSidebar

  if (!cwd) {
    return <EmptyState body={r.noProjectBody} title={r.noProjectTitle} />
  }

  if (error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
        <EmptyState body={r.unreadableBody(error)} title={r.unreadableTitle} />
        {onRetry && (
          <button
            className="text-[0.68rem] font-medium text-muted-foreground transition hover:text-foreground"
            onClick={onRetry}
            type="button"
          >
            {r.tryAgain}
          </button>
        )}
      </div>
    )
  }

  if (loading && data.length === 0) {
    return <FileTreeLoadingState />
  }

  if (data.length === 0) {
    return <EmptyState body={r.emptyBody} title={r.emptyTitle} />
  }

  return (
    <ErrorBoundary
      fallback={({ reset }) => (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <EmptyState body={r.treeErrorBody} title={r.treeErrorTitle} />
          <button
            className="text-[0.68rem] font-medium text-muted-foreground transition hover:text-foreground"
            onClick={reset}
            type="button"
          >
            {r.tryAgain}
          </button>
        </div>
      )}
      key={cwd}
      label="file-tree"
    >
      <ProjectTree
        collapseNonce={collapseNonce}
        cwd={cwd}
        data={data}
        onActivateFile={onActivateFile}
        onActivateFolder={onActivateFolder}
        onLoadChildren={onLoadChildren}
        onNodeOpenChange={onNodeOpenChange}
        onPreviewFile={onPreviewFile}
        onViewSourceFile={onViewSourceFile}
        openState={openState}
      />
    </ErrorBoundary>
  )
}

function FileTreeLoadingState() {
  const { t } = useI18n()

  return (
    <div aria-label={t.rightSidebar.loadingTree} className="grid min-h-0 flex-1 place-items-center px-3" role="status">
      <Loader
        aria-hidden="true"
        className="size-8 text-(--ui-text-tertiary)"
        pathSteps={180}
        role="presentation"
        strokeScale={0.68}
        type="spiral-search"
      />
    </div>
  )
}

function EmptyState({ body, title }: { body: string; title: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
      <div className="text-[0.7rem] font-semibold uppercase tracking-[0.07em] text-muted-foreground/75">{title}</div>
      <div className="text-[0.68rem] leading-relaxed text-muted-foreground/65">{body}</div>
    </div>
  )
}
