import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { expect, test, type ElectronApplication, type Page } from './test'
import {
  buildAppEnv,
  createSandbox,
  launchDesktop,
  type Sandbox,
  waitForAppReady,
  writeEnvFile,
  writeMockProviderConfig,
} from './fixtures'
import { startMockServer, type MockServer } from './mock-server'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const ACTIVE_PROFILE = 'review-active-e2e'
const SOURCE_PROFILE = 'review-source-e2e'
const SOURCE_SESSION = 'source-session'
const DECOY_SESSION = 'active-decoy-session'

interface SeedEvidence {
  sourceTask: string
  sourceComment: number
  decoyTask: string
  decoyComment: number
  taskRows: Array<{ id: string; title: string; session_id: string; tenant: string | null }>
  commentRows: Array<{ id: number; task_id: string; author: string; body: string }>
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
    source_task = kanban_db.create_task(conn, title="Source task", session_id="source-session")
    source_comment = kanban_db.add_comment(conn, source_task, "Source Builder", "SOURCE_ONLY_COMMENT")
    decoy_task = kanban_db.create_task(conn, title="Active decoy task", session_id="active-decoy-session")
    decoy_comment = kanban_db.add_comment(conn, decoy_task, "Wrong Profile", "ACTIVE_DECOY_COMMENT")
    task_rows = [dict(row) for row in conn.execute(
        "SELECT id, title, session_id, tenant FROM tasks WHERE id IN (?, ?) ORDER BY id",
        (source_task, decoy_task),
    ).fetchall()]
    comment_rows = [dict(row) for row in conn.execute(
        "SELECT id, task_id, author, body FROM task_comments WHERE task_id IN (?, ?) ORDER BY id",
        (source_task, decoy_task),
    ).fetchall()]
    print(json.dumps({
        "sourceTask": source_task,
        "sourceComment": source_comment,
        "decoyTask": decoy_task,
        "decoyComment": decoy_comment,
        "taskRows": task_rows,
        "commentRows": comment_rows,
    }))
finally:
    conn.close()
`

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: sandbox.root,
    HERMES_HOME: sandbox.hermesHome,
  }
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

  test('uses source-profile lineage with the shared board and gates polling by visible view', async ({}, testInfo) => {
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
        if (String(request.path ?? '').includes('/session-comments')) {
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
    await page.evaluate(
      ({ activeProfile, sourceProfile, sourceSession }) => {
        localStorage.setItem(
          'hermes.desktop.liveGraphPanes.v1',
          JSON.stringify({
            [activeProfile]: [
              {
                cwd: '',
                dock: 'center',
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
    const sessionComments = await api<{ comments: Array<{ body: string }> }>(page, {
      profile: SOURCE_PROFILE,
      path: `/api/plugins/kanban/session-comments?session_id=${SOURCE_SESSION}&board=default`,
    })
    const profileLocalKanbanPaths = [ACTIVE_PROFILE, SOURCE_PROFILE]
      .map(profile => path.join(sandbox.hermesHome, 'profiles', profile, 'kanban.db'))
      .filter(candidate => fs.existsSync(candidate))
    const rawEvidence = {
      sourceIdentity,
      seed,
      sessionSource,
      sessionComments,
      profileLocalKanbanPaths,
    }
    const rawEvidencePath = testInfo.outputPath('cross-profile-raw-evidence.json')
    fs.writeFileSync(rawEvidencePath, JSON.stringify(rawEvidence, null, 2))
    await testInfo.attach('cross-profile-raw-evidence', {
      path: rawEvidencePath,
      contentType: 'application/json',
    })

    expect(sourceIdentity.current).toBe(SOURCE_PROFILE)
    expect(sessionSource.tasks.map(task => task.id)).toContain(seed.sourceTask)
    expect(sessionSource.tasks.map(task => task.id)).not.toContain(seed.decoyTask)
    expect(sessionComments.comments.map(comment => comment.body)).toContain('SOURCE_ONLY_COMMENT')
    expect(sessionComments.comments.map(comment => comment.body)).not.toContain('ACTIVE_DECOY_COMMENT')
    expect(seed.taskRows.map(task => task.session_id).sort()).toEqual([DECOY_SESSION, SOURCE_SESSION].sort())
    expect(profileLocalKanbanPaths).toEqual([])

    await app.evaluate(() => {
      const scope = globalThis as typeof globalThis & {
        __scopedMessageCalls?: Array<{ path: string; profile: unknown; at: number }>
        __failScopedMessages?: boolean
      }
      scope.__scopedMessageCalls = []
      scope.__failScopedMessages = false
    })

    const graphTab = page.getByRole('tab', { name: /Graph View · Cross profile proof/ })
    await graphTab.click()
    const feed = page.getByTestId('live-graph-task-feed')
    await feed.waitFor({ state: 'visible', timeout: 30_000 })
    await feed.getByRole('button', { name: 'Messages' }).click()
    await expect(feed.getByText('SOURCE_ONLY_COMMENT')).toBeVisible({ timeout: 30_000 })
    await expect(feed.getByText('ACTIVE_DECOY_COMMENT')).toHaveCount(0)
    await expect(feed.locator('textarea, [contenteditable="true"]')).toHaveCount(0)

    await page.waitForTimeout(2_300)
    const visibleCalls = await app.evaluate(() =>
      (globalThis as typeof globalThis & { __scopedMessageCalls?: Array<{ profile: unknown }> })
        .__scopedMessageCalls ?? [],
    )
    expect(visibleCalls.length).toBeGreaterThanOrEqual(2)
    expect(visibleCalls.every(call => call.profile === SOURCE_PROFILE)).toBe(true)

    await feed.getByRole('button', { name: 'Tasks' }).click()
    const callsAtTasks = visibleCalls.length
    await page.waitForTimeout(2_300)
    const callsAfterTasks = await app.evaluate(() =>
      (globalThis as typeof globalThis & { __scopedMessageCalls?: unknown[] }).__scopedMessageCalls?.length ?? 0,
    )
    expect(callsAfterTasks).toBe(callsAtTasks)

    await feed.getByRole('button', { name: 'Messages' }).click()
    await expect(feed.getByText('SOURCE_ONLY_COMMENT')).toBeVisible()
    await app.evaluate(() => {
      ;(globalThis as typeof globalThis & { __failScopedMessages?: boolean }).__failScopedMessages = true
    })
    await expect(feed.getByText('Showing the last complete thread. Refresh failed.')).toBeVisible({ timeout: 10_000 })
    await expect(feed.getByText('SOURCE_ONLY_COMMENT')).toBeVisible()
    const staleScreenshotPath = testInfo.outputPath('messages-stale-snapshot.png')
    await page.screenshot({ path: staleScreenshotPath, fullPage: true })
    await testInfo.attach('messages-stale-snapshot', {
      path: staleScreenshotPath,
      contentType: 'image/png',
    })

    await feed.getByRole('button', { name: /View task: Source task/i }).click()
    const inspector = page.getByTestId('live-graph-selection-inspector')
    await expect(inspector).toBeVisible()
    await expect(inspector.getByRole('button', { name: 'Comments' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-live-graph-node-selection]')).toHaveCount(1)
    const provenanceScreenshotPath = testInfo.outputPath('provenance-comments-inspector.png')
    await page.screenshot({ path: provenanceScreenshotPath, fullPage: true })
    await testInfo.attach('provenance-comments-inspector', {
      path: provenanceScreenshotPath,
      contentType: 'image/png',
    })
  })
})
