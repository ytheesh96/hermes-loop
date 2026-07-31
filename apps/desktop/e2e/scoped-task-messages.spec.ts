import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  buildAppEnv,
  createSandbox,
  launchDesktop,
  type Sandbox,
  waitForAppReady,
  writeEnvFile,
  writeMockProviderConfig,
} from './fixtures'
import { type MockServer, startMockServer } from './mock-server'
import { type ElectronApplication, expect, type Page, test } from './test'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const ACTIVE_PROFILE = 'review-active-e2e'
const SOURCE_PROFILE = 'review-source-e2e'
const SOURCE_SESSION = 'source-session'
const DECOY_SESSION = 'active-decoy-session'

interface SeedEvidence {
  childTasks: [string, string]
  commentRows: Array<{
    author: string
    body: string
    created_at: number
    id: number
    task_id: string
  }>
  completionComments: [number, number]
  decompositionComment: number
  decoyComment: number
  decoyTask: string
  secondSourceTask: string
  sourceTask: string
  taskRows: Array<{
    body: string | null
    id: string
    session_id: string
    thread_root_task_id: string | null
    title: string
  }>
  threadRows: Array<{
    description: string
    origin_session_id: string
    root_task_id: string
    title: string
  }>
}

interface ScopedFixture {
  app: ElectronApplication
  mock: MockServer
  page: Page
  sandbox: Sandbox
  seed: SeedEvidence
  cleanup: () => Promise<void>
}

function seedScopedProfiles(sandbox: Sandbox): SeedEvidence {
  const sourceHome = path.join(sandbox.hermesHome, 'profiles', SOURCE_PROFILE)
  const activeHome = path.join(sandbox.hermesHome, 'profiles', ACTIVE_PROFILE)
  fs.mkdirSync(sourceHome, { recursive: true })
  fs.mkdirSync(activeHome, { recursive: true })

  const script = String.raw`
import json
import os
import time
from pathlib import Path

from hermes_cli import kanban_db
from hermes_state import SessionDB

root = Path(os.environ["HERMES_HOME"])
for profile, session_id in (("review-source-e2e", "source-session"), ("review-active-e2e", "active-decoy-session")):
    db = SessionDB(root / "profiles" / profile / "state.db")
    try:
        db.create_session(session_id, "cli")
    finally:
        db.close()

conn = kanban_db.connect(board="default")
try:
    source_graph = kanban_db.create_loop_skeleton_graph(
        conn,
        nodes=[{
            "client_id": "foreground-root",
            "title": "Canonical source request",
            "context": "IMMUTABLE_SOURCE_DESCRIPTION",
        }],
        session_id="source-session",
        created_by="foreground",
        board="default",
    )
    source_task = source_graph["items"][0]["task_id"]
    child_tasks = kanban_db.decompose_triage_task(
        conn,
        source_task,
        root_assignee=None,
        children=[{"title": "First child"}, {"title": "Second child"}],
        author="Source Decomposer",
        board="default",
    )
    assert child_tasks is not None and len(child_tasks) == 2
    late_comment = kanban_db.add_comment(
        conn, child_tasks[0], "First Builder", "CHILD_COMPLETION_LATEST"
    )
    early_comment = kanban_db.add_comment(
        conn, child_tasks[1], "Second Builder", "CHILD_COMPLETION_EARLIER"
    )

    second_source_graph = kanban_db.create_loop_skeleton_graph(
        conn,
        nodes=[{
            "client_id": "second-foreground-root",
            "title": "Second source request",
            "context": "SECOND_SOURCE_DESCRIPTION",
        }],
        session_id="source-session",
        created_by="foreground",
        board="default",
    )
    second_source_task = second_source_graph["items"][0]["task_id"]
    second_source_comment = kanban_db.add_comment(
        conn, second_source_task, "Later Builder", "SECOND_SOURCE_LATEST_ACTIVITY"
    )

    decoy_graph = kanban_db.create_loop_skeleton_graph(
        conn,
        nodes=[{
            "client_id": "active-decoy",
            "title": "Active decoy request",
            "context": "ACTIVE_DECOY_DESCRIPTION",
        }],
        session_id="active-decoy-session",
        created_by="foreground",
        board="default",
    )
    decoy_task = decoy_graph["items"][0]["task_id"]
    decoy_comment = kanban_db.add_comment(
        conn, decoy_task, "Wrong Profile", "ACTIVE_DECOY_COMMENT"
    )

    decomposition_comment = conn.execute(
        "SELECT id FROM task_comments WHERE task_id = ? AND author = ?",
        (source_task, "Source Decomposer"),
    ).fetchone()["id"]
    # Same-second reply IDs must be compared numerically (2 before 10), while
    # thread roots remain in immutable creation order despite later activity.
    now = int(time.time())
    with kanban_db.write_txn(conn):
        conn.execute(
            "UPDATE tasks SET body = ? WHERE id = ?",
            ("MUTATED_WORKER_SPECIFICATION", source_task),
        )
        conn.execute(
            "UPDATE task_comments SET created_at = ? WHERE id = ?",
            (now - 3, decomposition_comment),
        )
        conn.execute(
            "UPDATE task_comments SET created_at = ? WHERE id IN (?, ?)",
            (now - 2, late_comment, early_comment),
        )
        conn.execute(
            "UPDATE task_comments SET id = 10 WHERE id = ?",
            (early_comment,),
        )
        conn.execute("UPDATE sqlite_sequence SET seq = 10 WHERE name = 'task_comments'")
        early_comment = 10
        conn.execute(
            "UPDATE task_comments SET created_at = ? WHERE id = ?",
            (now - 1, second_source_comment),
        )
        conn.execute(
            "UPDATE task_threads SET created_at = ? WHERE root_task_id = ?",
            (now - 10, source_task),
        )
        conn.execute(
            "UPDATE task_threads SET created_at = ? WHERE root_task_id = ?",
            (now - 5, second_source_task),
        )

    task_rows = [dict(row) for row in conn.execute(
        "SELECT id, title, body, session_id, thread_root_task_id FROM tasks "
        "WHERE id IN (?, ?, ?, ?, ?) ORDER BY id",
        (source_task, child_tasks[0], child_tasks[1], second_source_task, decoy_task),
    ).fetchall()]
    comment_rows = [dict(row) for row in conn.execute(
        "SELECT id, task_id, author, body, created_at FROM task_comments "
        "WHERE task_id IN (?, ?, ?, ?, ?) ORDER BY created_at, id",
        (source_task, child_tasks[0], child_tasks[1], second_source_task, decoy_task),
    ).fetchall()]
    thread_rows = [dict(row) for row in conn.execute(
        "SELECT root_task_id, origin_session_id, title, description FROM task_threads "
        "WHERE root_task_id IN (?, ?, ?) ORDER BY root_task_id",
        (source_task, second_source_task, decoy_task),
    ).fetchall()]
    print(json.dumps({
        "childTasks": child_tasks,
        "commentRows": comment_rows,
        "completionComments": [late_comment, early_comment],
        "decompositionComment": decomposition_comment,
        "decoyComment": decoy_comment,
        "decoyTask": decoy_task,
        "secondSourceTask": second_source_task,
        "sourceTask": source_task,
        "taskRows": task_rows,
        "threadRows": thread_rows,
    }))
finally:
    conn.close()
`

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: sandbox.root,
    HERMES_HOME: sandbox.hermesHome,
  }
  delete env.HERMES_DELEGATED_CHILD_CONTEXT
  delete env.HERMES_KANBAN_DB
  delete env.HERMES_KANBAN_BOARD
  const result = spawnSync('uv', ['run', 'python', '-c', script], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`Failed to seed scoped Messages E2E fixture:\n${result.stderr}`)
  }
  return JSON.parse(result.stdout.trim()) as SeedEvidence
}

async function setupScopedFixture(): Promise<ScopedFixture> {
  const mock = await startMockServer()
  const sandbox = createSandbox('scoped-task-messages')
  const sourceHome = path.join(sandbox.hermesHome, 'profiles', SOURCE_PROFILE)
  const activeHome = path.join(sandbox.hermesHome, 'profiles', ACTIVE_PROFILE)
  fs.mkdirSync(sourceHome, { recursive: true })
  fs.mkdirSync(activeHome, { recursive: true })
  writeMockProviderConfig(sourceHome, mock.url)
  writeEnvFile(sourceHome)
  writeMockProviderConfig(activeHome, mock.url)
  writeEnvFile(activeHome)
  const seed = seedScopedProfiles(sandbox)
  fs.writeFileSync(
    path.join(sandbox.userDataDir, 'active-profile.json'),
    JSON.stringify({ profile: ACTIVE_PROFILE }),
  )

  const env = buildAppEnv(sandbox, { HOME: sandbox.root })
  delete env.HERMES_DELEGATED_CHILD_CONTEXT
  delete env.HERMES_KANBAN_TASK
  delete env.HERMES_KANBAN_RUN_ID
  delete env.HERMES_KANBAN_WORKSPACE
  delete env.HERMES_KANBAN_WORKSPACES_ROOT
  delete env.HERMES_KANBAN_CLAIM_LOCK
  delete env.HERMES_KANBAN_DB
  delete env.HERMES_KANBAN_BOARD
  const { app, page } = await launchDesktop(env)
  await waitForAppReady({ app, page, mock, mockUrl: mock.url, sandbox, cleanup: async () => undefined }, 120_000)

  return {
    app,
    mock,
    page,
    sandbox,
    seed,
    cleanup: async () => {
      await app.close().catch(() => undefined)
      await mock.close().catch(() => undefined)
      sandbox.cleanup()
    },
  }
}

async function api<T>(page: Page, request: Record<string, unknown>): Promise<T> {
  return page.evaluate(
    options => (window as typeof window & { hermesDesktop: { api: (value: unknown) => Promise<T> } }).hermesDesktop.api(options),
    request,
  )
}

async function persistFeedPane(page: Page): Promise<void> {
  await page.evaluate(
    ({ activeProfile, sourceProfile, sourceSession }) => {
      localStorage.setItem(
        'hermes.desktop.liveGraphPanes.v1',
        JSON.stringify({
          [activeProfile]: [
            {
              cwd: '',
              dock: 'center',
              mode: 'feed',
              sessionRootId: sourceSession,
              sourcePaneId: 'workspace',
              sourceProfile,
              sourceSessionId: sourceSession,
              title: 'Cross profile proof',
            },
          ],
        }),
      )
    },
    { activeProfile: ACTIVE_PROFILE, sourceProfile: SOURCE_PROFILE, sourceSession: SOURCE_SESSION },
  )
}

test.describe('scoped task Messages across profile backends', () => {
  test.setTimeout(180_000)

  let fixture: ScopedFixture | null = null

  test.beforeAll(async () => {
    fixture = await setupScopedFixture()
  })

  test.afterAll(async () => {
    await fixture?.cleanup()
    fixture = null
  })

  test('renders immutable Buzz-style threads and retains a stale snapshot after cold reopen', async ({}, testInfo) => {
    const { app, page, sandbox, seed } = fixture!
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as typeof ipcMain & {
        _invokeHandlers: Map<string, (event: unknown, request: Record<string, unknown>) => Promise<unknown>>
      })._invokeHandlers
      const originalApiHandler = handlers.get('hermes:api')
      if (!originalApiHandler) {
        throw new Error('hermes:api IPC handler is unavailable')
      }
      const scope = globalThis as typeof globalThis & {
        __scopedMessageCalls?: Array<{ path: string; profile: unknown; at: number }>
        __failScopedMessages?: boolean
      }
      scope.__scopedMessageCalls = []
      scope.__failScopedMessages = false
      ipcMain.removeHandler('hermes:api')
      ipcMain.handle('hermes:api', async (event, request: Record<string, unknown>) => {
        if (String(request.path ?? '').includes('/session-threads')) {
          scope.__scopedMessageCalls!.push({
            path: String(request.path),
            profile: request.profile ?? null,
            at: Date.now(),
          })
          if (scope.__failScopedMessages) {
            throw new Error('forced scoped Messages refresh failure')
          }
        }
        return originalApiHandler(event, request)
      })
    })
    await persistFeedPane(page)
    await page.reload()
    await waitForAppReady(
      { ...fixture!, cleanup: async () => undefined, mockUrl: fixture!.mock.url },
      120_000,
    )

    const sourceIdentity = await api<{ current: string }>(page, {
      profile: SOURCE_PROFILE,
      path: '/api/profiles/active',
    })
    const sessionSource = await api<{ tasks: Array<{ id: string }> }>(page, {
      profile: SOURCE_PROFILE,
      path: `/api/plugins/kanban/session-source?session_id=${SOURCE_SESSION}&board=default`,
    })
    const sessionThreads = await api<{
      replies: Array<{ body: string; created_at: number; id: number; root_task_id: string }>
      threads: Array<{ description: string; root_task_id: string }>
    }>(page, {
      profile: SOURCE_PROFILE,
      path: `/api/plugins/kanban/session-threads?session_id=${SOURCE_SESSION}&board=default`,
    })
    const profileLocalKanbanPaths = [ACTIVE_PROFILE, SOURCE_PROFILE]
      .map(profile => path.join(sandbox.hermesHome, 'profiles', profile, 'kanban.db'))
      .filter(candidate => fs.existsSync(candidate))
    const rawEvidence = {
      profileLocalKanbanPaths,
      seed,
      sessionSource,
      sessionThreads,
      sourceIdentity,
    }
    const rawEvidencePath = testInfo.outputPath('buzz-thread-raw-evidence.json')
    fs.writeFileSync(rawEvidencePath, JSON.stringify(rawEvidence, null, 2))
    await testInfo.attach('buzz-thread-raw-evidence', {
      path: rawEvidencePath,
      contentType: 'application/json',
    })

    expect(sourceIdentity.current).toBe(SOURCE_PROFILE)
    expect(sessionSource.tasks.map(task => task.id)).toContain(seed.sourceTask)
    expect(sessionSource.tasks.map(task => task.id)).not.toContain(seed.decoyTask)
    expect(sessionThreads.threads).toEqual([
      expect.objectContaining({
        description: 'IMMUTABLE_SOURCE_DESCRIPTION',
        root_task_id: seed.sourceTask,
      }),
      expect.objectContaining({
        description: 'SECOND_SOURCE_DESCRIPTION',
        root_task_id: seed.secondSourceTask,
      }),
    ])
    const sourceReplies = sessionThreads.replies.filter(reply => reply.root_task_id === seed.sourceTask)
    expect(sourceReplies.map(reply => reply.body)).toEqual([
      expect.stringContaining('Decomposed into First child'),
      'CHILD_COMPLETION_LATEST',
      'CHILD_COMPLETION_EARLIER',
    ])
    expect(sourceReplies.slice(1).map(reply => reply.id)).toEqual([2, 10])
    expect(sessionThreads.replies.map(reply => [reply.created_at, reply.id])).toEqual(
      [...sessionThreads.replies]
        .sort((left, right) => left.created_at - right.created_at || left.id - right.id)
        .map(reply => [reply.created_at, reply.id]),
    )
    expect(new Set(sessionThreads.replies.map(reply => reply.root_task_id))).toEqual(
      new Set([seed.sourceTask, seed.secondSourceTask]),
    )
    expect(sessionThreads.replies.map(reply => reply.body)).not.toContain('ACTIVE_DECOY_COMMENT')
    expect(new Set(seed.taskRows.map(task => task.session_id))).toEqual(new Set([DECOY_SESSION, SOURCE_SESSION]))
    expect(seed.threadRows.find(row => row.root_task_id === seed.sourceTask)?.description).toBe(
      'IMMUTABLE_SOURCE_DESCRIPTION',
    )
    expect(seed.taskRows.find(row => row.id === seed.sourceTask)?.body).toBe('MUTATED_WORKER_SPECIFICATION')
    expect(profileLocalKanbanPaths).toEqual([])

    await app.evaluate(() => {
      const scope = globalThis as typeof globalThis & {
        __scopedMessageCalls?: Array<{ path: string; profile: unknown; at: number }>
        __failScopedMessages?: boolean
      }
      scope.__scopedMessageCalls = []
      scope.__failScopedMessages = false
    })

    const feedTab = page.getByRole('tab', { name: /Task feed · Cross profile proof/ })
    await feedTab.click()
    const feed = page.getByTestId('scoped-task-feed-pane')
    await feed.waitFor({ state: 'visible', timeout: 30_000 })
    await feed.getByRole('button', { exact: true, name: 'Messages' }).click()
    await expect(feed.getByText('IMMUTABLE_SOURCE_DESCRIPTION')).toBeVisible({ timeout: 30_000 })
    await expect(feed.getByText('ACTIVE_DECOY_DESCRIPTION')).toHaveCount(0)
    await expect(feed.getByText('ACTIVE_DECOY_COMMENT')).toHaveCount(0)
    await expect(feed.locator('textarea, [contenteditable="true"]')).toHaveCount(0)
    await expect(feed.locator('[data-live-graph-task-card]')).toHaveCount(0)
    await expect(feed.getByRole('button', { name: /View task:/i })).toHaveCount(0)
    await expect(page.getByTestId('live-graph-selection-inspector')).toHaveCount(0)

    const thread = feed.getByTestId('live-graph-message-thread')
    const rootMessages = thread.getByTestId('live-graph-thread-root')
    const replies = thread.getByTestId('live-graph-thread-comment')
    await expect(rootMessages).toHaveCount(1)
    await expect(replies).toHaveCount(3)
    await expect(rootMessages.first()).toContainText('IMMUTABLE_SOURCE_DESCRIPTION')
    await expect(replies.nth(0)).toContainText('Decomposed into First child')
    await expect(replies.nth(1)).toContainText('CHILD_COMPLETION_LATEST')
    await expect(replies.nth(2)).toContainText('CHILD_COMPLETION_EARLIER')
    await expect(feed.getByRole('button', { name: /Messages:/ })).toHaveCount(2)
    expect(await feed.getByRole('button', { name: /Messages:/ }).allTextContents()).toEqual([
      expect.stringContaining('Canonical source request'),
      expect.stringContaining('Second source request'),
    ])
    expect(
      await thread.evaluate(element =>
        Array.from(element.querySelectorAll('[data-testid^="live-graph-thread-"]')).map(node =>
          node.textContent?.trim(),
        ),
      ),
    ).toEqual([
      expect.stringContaining('IMMUTABLE_SOURCE_DESCRIPTION'),
      expect.stringContaining('Decomposed into First child'),
      expect.stringContaining('CHILD_COMPLETION_LATEST'),
      expect.stringContaining('CHILD_COMPLETION_EARLIER'),
    ])
    expect(
      await thread.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 2),
    ).toBe(true)

    await api(page, {
      profile: SOURCE_PROFILE,
      method: 'POST',
      path: `/api/plugins/kanban/tasks/${seed.childTasks[0]}/comments?board=default`,
      body: {
        author: 'Pinned Builder',
        body: `PINNED_APPEND\n${'line\n'.repeat(80)}`,
      },
    })
    await expect(feed.getByText(/PINNED_APPEND/)).toBeVisible({ timeout: 10_000 })
    expect(
      await thread.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 2),
    ).toBe(true)

    await thread.evaluate(element => {
      element.scrollTop = 0
      element.dispatchEvent(new Event('scroll'))
    })
    expect(await thread.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    await api(page, {
      profile: SOURCE_PROFILE,
      method: 'POST',
      path: `/api/plugins/kanban/tasks/${seed.childTasks[1]}/comments?board=default`,
      body: { author: 'Reading Builder', body: 'UNPINNED_APPEND' },
    })
    await feed.getByText('UNPINNED_APPEND', { exact: true }).waitFor({ state: 'attached', timeout: 10_000 })
    expect(await thread.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(2)

    await page.waitForTimeout(2_300)
    const visibleCalls = await app.evaluate(() =>
      (globalThis as typeof globalThis & { __scopedMessageCalls?: Array<{ profile: unknown }> })
        .__scopedMessageCalls ?? [],
    )
    expect(visibleCalls.length).toBeGreaterThanOrEqual(2)
    expect(visibleCalls.every(call => call.profile === SOURCE_PROFILE)).toBe(true)
    await expect(replies).toHaveCount(5)
    await expect(feed.getByText('CHILD_COMPLETION_EARLIER', { exact: true })).toHaveCount(1)
    await expect(feed.getByText('CHILD_COMPLETION_LATEST', { exact: true })).toHaveCount(1)

    await feed.getByRole('button', { exact: true, name: 'Tasks' }).click()
    const callsAtTasks = visibleCalls.length
    await page.waitForTimeout(2_300)
    const callsAfterTasks = await app.evaluate(() =>
      (globalThis as typeof globalThis & { __scopedMessageCalls?: unknown[] }).__scopedMessageCalls?.length ?? 0,
    )
    expect(callsAfterTasks).toBe(callsAtTasks)

    await persistFeedPane(page)
    await page.reload()
    await waitForAppReady(
      { ...fixture!, cleanup: async () => undefined, mockUrl: fixture!.mock.url },
      120_000,
    )
    const reopenedFeedTab = page.getByRole('tab', { name: /Task feed · Cross profile proof/ })
    await reopenedFeedTab.click()
    const reopenedFeed = page.getByTestId('scoped-task-feed-pane')
    await reopenedFeed.waitFor({ state: 'visible', timeout: 30_000 })
    await reopenedFeed.getByRole('button', { exact: true, name: 'Messages' }).click()
    await expect(reopenedFeed.getByText('IMMUTABLE_SOURCE_DESCRIPTION')).toBeVisible({ timeout: 30_000 })
    await expect(reopenedFeed.getByTestId('live-graph-thread-comment')).toHaveCount(5)
    await expect(reopenedFeed.getByText('CHILD_COMPLETION_LATEST', { exact: true })).toHaveCount(1)

    await app.evaluate(() => {
      ;(globalThis as typeof globalThis & { __failScopedMessages?: boolean }).__failScopedMessages = true
    })
    await expect(reopenedFeed.getByText('Showing the last complete thread. Refresh failed.')).toBeVisible({ timeout: 10_000 })
    await expect(reopenedFeed.getByText('IMMUTABLE_SOURCE_DESCRIPTION')).toBeVisible()
    await expect(reopenedFeed.getByText('CHILD_COMPLETION_LATEST', { exact: true })).toHaveCount(1)
    await expect(reopenedFeed.getByRole('button', { name: /View task:/i })).toHaveCount(0)
    await expect(page.locator('[data-live-graph-node-selection]')).toHaveCount(0)

    const staleScreenshotPath = testInfo.outputPath('messages-stale-snapshot.png')
    await page.screenshot({ path: staleScreenshotPath, fullPage: true })
    await testInfo.attach('messages-stale-snapshot', {
      path: staleScreenshotPath,
      contentType: 'image/png',
    })
  })
})
