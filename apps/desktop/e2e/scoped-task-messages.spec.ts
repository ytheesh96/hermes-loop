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
  writeMockProviderConfig
} from './fixtures'
import { type MockServer, startMockServer } from './mock-server'
import { type ElectronApplication, expect, type Page, test } from './test'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const ACTIVE_PROFILE = 'review-active-e2e'
const SOURCE_PROFILE = 'review-source-e2e'
const SOURCE_SESSION = 'source-session'
const DECOY_SESSION = 'active-decoy-session'
const SURFACE = '[data-composer-target]:not([data-pane-hidden] [data-composer-target])'

async function assertNoHorizontalOverflow(
  page: Page,
  width: number
): Promise<Record<string, { clientWidth: number; scrollWidth: number }>> {
  await page.setViewportSize({ width, height: page.viewportSize()?.height ?? 720 })

  return page.evaluate(
    ({ width }) => {
      const selectors = {
        launcher: '.task-feed-launcher-row',
        pane: '[data-testid="scoped-task-feed-pane"]',
        thread: '[data-testid="live-graph-message-thread"]',
        assignment: '[data-testid="live-graph-thread-assignment"]'
      }
      const measurements: Record<string, { clientWidth: number; scrollWidth: number }> = {}

      for (const [name, selector] of Object.entries(selectors)) {
        const element = document.querySelector<HTMLElement>(selector)
        if (!element && name !== 'launcher') {
          throw new Error(`${name} is missing at ${width}px`)
        }
        if (!element) continue
        const measurement = { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }
        if (measurement.scrollWidth > measurement.clientWidth) {
          throw new Error(`${name} overflows: ${JSON.stringify(measurement)}`)
        }
        measurements[name] = measurement
      }

      return measurements
    },
    { width }
  )
}

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
  workflowId: string
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
from urllib.parse import quote

from hermes_cli import kanban_db
from hermes_state import SessionDB

root = Path(os.environ["HERMES_HOME"])
artifact = root / "report.pdf"
content = b"q 0 0 200 200 re S Q\n"
pdf_objects = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << >> >>",
    b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"endstream",
]
pdf = bytearray(b"%PDF-1.4\n")
offsets = [0]
for number, body in enumerate(pdf_objects, 1):
    offsets.append(len(pdf))
    pdf.extend(f"{number} 0 obj\n".encode())
    pdf.extend(body)
    pdf.extend(b"\nendobj\n")
xref_offset = len(pdf)
pdf.extend(f"xref\n0 {len(pdf_objects) + 1}\n".encode())
pdf.extend(b"0000000000 65535 f \n")
for offset in offsets[1:]:
    pdf.extend(f"{offset:010d} 00000 n \n".encode())
pdf.extend(f"trailer\n<< /Size {len(pdf_objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n".encode())
artifact.write_bytes(bytes(pdf))
assert pdf.startswith(b"%PDF-1.4\n") and pdf.endswith(b"%%EOF\n")
assert pdf_objects[3].startswith(b"<< /Length " + str(len(content)).encode())
source_description = (
    "IMMUTABLE_SOURCE_DESCRIPTION\n\n"
    "[HTTPS review](https://example.com/review)\n\n"
    f"[Preview: report.pdf](#preview/{quote(str(artifact), safe='')})"
)
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
            "context": source_description,
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
    with kanban_db.write_txn(conn):
        conn.executemany(
            "UPDATE tasks SET assignee = 'Builder' WHERE id = ?",
            [(task_id,) for task_id in child_tasks],
        )
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
        "workflowId": source_graph["workflow_id"],
        "taskRows": task_rows,
        "threadRows": thread_rows,
    }))
finally:
    conn.close()
`

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: sandbox.root,
    HERMES_HOME: sandbox.hermesHome
  }
  delete env.HERMES_DELEGATED_CHILD_CONTEXT
  delete env.HERMES_KANBAN_DB
  delete env.HERMES_KANBAN_BOARD
  const result = spawnSync('uv', ['run', 'python', '-c', script], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8'
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
  fs.writeFileSync(path.join(sandbox.userDataDir, 'active-profile.json'), JSON.stringify({ profile: ACTIVE_PROFILE }))

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
    }
  }
}

async function api<T>(page: Page, request: Record<string, unknown>): Promise<T> {
  return page.evaluate(
    options =>
      (window as typeof window & { hermesDesktop: { api: (value: unknown) => Promise<T> } }).hermesDesktop.api(options),
    request
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
              title: 'Cross profile proof'
            }
          ]
        })
      )
    },
    { activeProfile: ACTIVE_PROFILE, sourceProfile: SOURCE_PROFILE, sourceSession: SOURCE_SESSION }
  )
}

async function persistGraphPane(page: Page): Promise<void> {
  await page.evaluate(
    ({ activeProfile, sourceProfile, sourceSession }) => {
      localStorage.setItem(
        'hermes.desktop.liveGraphPanes.v1',
        JSON.stringify({
          [activeProfile]: [
            {
              cwd: '',
              dock: 'center',
              mode: 'graph',
              sessionRootId: sourceSession,
              sourcePaneId: 'workspace',
              sourceProfile,
              sourceSessionId: sourceSession,
              title: 'Graph proof'
            }
          ]
        })
      )
    },
    { activeProfile: ACTIVE_PROFILE, sourceProfile: SOURCE_PROFILE, sourceSession: SOURCE_SESSION }
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
      const handlers = (
        ipcMain as typeof ipcMain & {
          _invokeHandlers: Map<string, (event: unknown, request: Record<string, unknown>) => Promise<unknown>>
        }
      )._invokeHandlers
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
            at: Date.now()
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
    await waitForAppReady({ ...fixture!, cleanup: async () => undefined, mockUrl: fixture!.mock.url }, 120_000)

    const sourceIdentity = await api<{ current: string }>(page, {
      profile: SOURCE_PROFILE,
      path: '/api/profiles/active'
    })
    const sessionSource = await api<{ tasks: Array<{ id: string }> }>(page, {
      profile: SOURCE_PROFILE,
      path: `/api/plugins/kanban/session-source?session_id=${SOURCE_SESSION}&board=default`
    })
    const sessionThreads = await api<{
      replies: Array<{ body: string; created_at: number; id: number; root_task_id: string }>
      threads: Array<{ description: string; root_task_id: string }>
    }>(page, {
      profile: SOURCE_PROFILE,
      path: `/api/plugins/kanban/session-threads?session_id=${SOURCE_SESSION}&board=default`
    })
    const profileLocalKanbanPaths = [ACTIVE_PROFILE, SOURCE_PROFILE]
      .map(profile => path.join(sandbox.hermesHome, 'profiles', profile, 'kanban.db'))
      .filter(candidate => fs.existsSync(candidate))
    const rawEvidence = {
      profileLocalKanbanPaths,
      seed,
      sessionSource,
      sessionThreads,
      sourceIdentity
    }
    const rawEvidencePath = testInfo.outputPath('buzz-thread-raw-evidence.json')
    fs.writeFileSync(rawEvidencePath, JSON.stringify(rawEvidence, null, 2))
    await testInfo.attach('buzz-thread-raw-evidence', {
      path: rawEvidencePath,
      contentType: 'application/json'
    })

    expect(sourceIdentity.current).toBe(SOURCE_PROFILE)
    expect(sessionSource.tasks.map(task => task.id)).toContain(seed.sourceTask)
    expect(sessionSource.tasks.map(task => task.id)).not.toContain(seed.decoyTask)
    expect(sessionThreads.threads).toEqual([
      expect.objectContaining({
        description: expect.stringContaining('IMMUTABLE_SOURCE_DESCRIPTION'),
        root_task_id: seed.sourceTask
      }),
      expect.objectContaining({
        description: 'SECOND_SOURCE_DESCRIPTION',
        root_task_id: seed.secondSourceTask
      })
    ])
    const sourceReplies = sessionThreads.replies.filter(reply => reply.root_task_id === seed.sourceTask)
    expect(sourceReplies.map(reply => reply.body)).toEqual([
      expect.stringContaining('Decomposed into First child'),
      'CHILD_COMPLETION_LATEST',
      'CHILD_COMPLETION_EARLIER'
    ])
    expect(sourceReplies.slice(1).map(reply => reply.id)).toEqual([2, 10])
    expect(sessionThreads.replies.map(reply => [reply.created_at, reply.id])).toEqual(
      [...sessionThreads.replies]
        .sort((left, right) => left.created_at - right.created_at || left.id - right.id)
        .map(reply => [reply.created_at, reply.id])
    )
    expect(new Set(sessionThreads.replies.map(reply => reply.root_task_id))).toEqual(
      new Set([seed.sourceTask, seed.secondSourceTask])
    )
    expect(sessionThreads.replies.map(reply => reply.body)).not.toContain('ACTIVE_DECOY_COMMENT')
    expect(new Set(seed.taskRows.map(task => task.session_id))).toEqual(new Set([DECOY_SESSION, SOURCE_SESSION]))
    expect(seed.threadRows.find(row => row.root_task_id === seed.sourceTask)?.description).toContain(
      'IMMUTABLE_SOURCE_DESCRIPTION'
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

    const feedTab = page.getByRole('tab', { name: /Messages · Cross profile proof/ })
    await feedTab.click()
    const feed = page.getByTestId('scoped-task-feed-pane')
    await feed.waitFor({ state: 'visible', timeout: 30_000 })
    await expect(feed.getByText('IMMUTABLE_SOURCE_DESCRIPTION')).toBeVisible({ timeout: 30_000 })
    await expect(feed.getByText('ACTIVE_DECOY_DESCRIPTION')).toHaveCount(0)
    await expect(feed.getByText('ACTIVE_DECOY_COMMENT')).toHaveCount(0)
    await expect(feed.locator('textarea, [contenteditable="true"]')).toHaveCount(0)
    await expect(feed.locator('[data-live-graph-task-card]')).toHaveCount(0)
    await expect(page.getByRole('tab', { name: /^Tasks$/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Task feed|Tasks/i })).toHaveCount(0)
    await expect(page.getByTestId('live-graph-task-feed')).toHaveCount(0)
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
      expect.stringContaining('Second source request')
    ])
    const threadEntries = await thread.evaluate(element =>
      Array.from(element.querySelectorAll('[data-testid^="live-graph-thread-"]')).map(node => node.textContent?.trim())
    )
    expect(threadEntries.slice(0, 4)).toEqual([
      expect.stringContaining('IMMUTABLE_SOURCE_DESCRIPTION'),
      expect.stringContaining('Decomposed into First child'),
      expect.stringContaining('CHILD_COMPLETION_LATEST'),
      expect.stringContaining('CHILD_COMPLETION_EARLIER')
    ])
    expect(threadEntries.slice(4)).toEqual(
      expect.arrayContaining([expect.stringContaining('First child'), expect.stringContaining('Second child')])
    )
    expect(await thread.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 2)).toBe(
      true
    )

    const secondThread = feed.getByRole('button', { name: /Messages: Second source request/ })
    await secondThread.click()
    await expect(feed.getByTestId('live-graph-thread-assignment')).toHaveCount(2)
    await expect(feed.getByRole('link', { name: 'HTTPS review' })).toHaveAttribute('href', 'https://example.com/review')
    const preview = feed.getByRole('button', { name: /Open preview|Hide preview/ })
    await expect(preview).toBeVisible()
    await preview.click()
    await expect(page.getByRole('tab', { name: 'report.pdf' })).toBeVisible()
    await expect(page.locator('[aria-label="Loading preview"]')).toHaveCount(0)
    await expect(page.locator('.preview-source-code')).toBeVisible()
    await expect(page.locator('.preview-source-code')).toContainText('q 0 0 200 200 re S Q')
    await expect(page.getByText('Preview unavailable')).toHaveCount(0)
    await page.getByRole('button', { name: 'Close preview pane' }).click()
    await expect(page.getByRole('tab', { name: 'report.pdf' })).toHaveCount(0)

    await api(page, {
      profile: SOURCE_PROFILE,
      method: 'POST',
      path: `/api/plugins/kanban/tasks/${seed.childTasks[0]}/comments?board=default`,
      body: {
        author: 'Pinned Builder',
        body: `PINNED_APPEND\n${'line\n'.repeat(400)}`
      }
    })
    await expect(feed.getByText(/PINNED_APPEND/)).toBeVisible({ timeout: 10_000 })
    expect(await thread.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 2)).toBe(
      true
    )

    await thread.evaluate(element => {
      element.scrollTop = 100
      element.dispatchEvent(new Event('scroll'))
    })
    expect(await thread.evaluate(element => element.scrollTop)).toBe(100)
    const wideAssignedMeasurements = await assertNoHorizontalOverflow(page, 1440)
    await page.setViewportSize({ width: 640, height: 900 })
    const narrowAssignedMeasurements = await assertNoHorizontalOverflow(page, 640)
    expect(Object.keys(wideAssignedMeasurements)).toEqual(expect.arrayContaining(['pane', 'thread', 'assignment']))
    expect(Object.keys(narrowAssignedMeasurements)).toEqual(expect.arrayContaining(['pane', 'thread', 'assignment']))
    await thread.evaluate(element => {
      element.scrollTop = 100
      element.dispatchEvent(new Event('scroll'))
    })
    expect(await thread.evaluate(element => element.scrollTop)).toBe(100)
    const assignment = feed.getByTestId('live-graph-thread-assignment').filter({ hasText: 'Second child' })
    await expect(assignment).toHaveCount(1)
    await assignment.getByRole('button').click()
    await expect(page.getByTestId('live-graph-task-activity')).toBeVisible()
    const assignmentInspector = page.getByTestId('live-graph-selection-inspector')
    await expect(assignmentInspector).toHaveAttribute(
      'data-live-graph-node-selection',
      expect.stringContaining(seed.childTasks[1])
    )
    await page.getByRole('button', { name: 'Back' }).click()
    await expect(feed).toBeVisible()
    await expect(secondThread).toHaveAttribute('aria-expanded', 'true')
    expect(await thread.evaluate(element => element.scrollTop)).toBe(100)

    await thread.evaluate(element => {
      element.scrollTop = 0
      element.dispatchEvent(new Event('scroll'))
    })
    expect(await thread.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    await api(page, {
      profile: SOURCE_PROFILE,
      method: 'POST',
      path: `/api/plugins/kanban/tasks/${seed.childTasks[1]}/comments?board=default`,
      body: { author: 'Reading Builder', body: 'UNPINNED_APPEND' }
    })
    await feed.getByText('UNPINNED_APPEND', { exact: true }).waitFor({ state: 'attached', timeout: 10_000 })
    expect(await thread.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(2)

    await page.waitForTimeout(2_300)
    const visibleCalls = await app.evaluate(
      () =>
        (globalThis as typeof globalThis & { __scopedMessageCalls?: Array<{ profile: unknown }> })
          .__scopedMessageCalls ?? []
    )
    expect(visibleCalls.length).toBeGreaterThanOrEqual(2)
    expect(visibleCalls.every(call => call.profile === SOURCE_PROFILE)).toBe(true)
    await expect(replies).toHaveCount(6)
    await expect(feed.getByText('CHILD_COMPLETION_EARLIER', { exact: true })).toHaveCount(1)
    await expect(feed.getByText('CHILD_COMPLETION_LATEST', { exact: true })).toHaveCount(1)

    await persistGraphPane(page)
    await page.reload()
    await waitForAppReady({ ...fixture!, cleanup: async () => undefined, mockUrl: fixture!.mock.url }, 120_000)
    const initialGraphProofTab = page.getByRole('tab', { name: /Graph proof/ })
    await initialGraphProofTab.click()
    await expect(page.locator('[data-live-graph-canvas]:visible')).toBeVisible({ timeout: 30_000 })
    const workflowNodeId = `workflow:${SOURCE_PROFILE}:default:${seed.workflowId}`
    const workflowNode = page.locator(`[data-live-graph-node-id="${workflowNodeId}"]:visible`)
    await expect(workflowNode).toBeVisible({ timeout: 30_000 })
    await workflowNode.click()
    await expect(workflowNode.locator('[data-live-graph-node-selection]')).toBeVisible()
    const workflowInbox = page.getByRole('region', { name: 'Workflow task inbox' })
    await expect(workflowInbox).toBeVisible()
    const workflowTaskCard = page.locator(
      `[data-live-graph-task-card="task:${SOURCE_PROFILE}:default:${seed.childTasks[0]}"]`
    )
    await expect(workflowTaskCard).toContainText('First child')
    await workflowTaskCard.locator('button').click()
    await expect(page.getByTestId('live-graph-task-activity')).toBeVisible()
    const selectedGraphNode = page
      .locator('[data-live-graph-node]')
      .filter({ has: page.locator('[data-live-graph-node-selection]') })
    await expect(selectedGraphNode).toHaveAttribute(
      'data-live-graph-node-id',
      expect.stringContaining(seed.childTasks[0])
    )

    await page.locator('[role="tab"][data-tree-tab="workspace"]').click()
    const chatComposer = page.locator(SURFACE).last().locator('[contenteditable="true"]').first()
    await chatComposer.waitFor({ state: 'visible', timeout: 15_000 })
    await chatComposer.fill('/loop')
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-live-graph-canvas]:visible')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('tab', { name: /Task feed|Tasks/i })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Task feed|Tasks/i })).toHaveCount(0)
    await expect(page.getByTestId('live-graph-task-feed')).toHaveCount(0)
    await expect(page.locator('[data-live-graph-task-card]')).toHaveCount(0)
    await expect(page.locator('[role="complementary"]').filter({ hasText: /Task feed/i })).toHaveCount(0)
    const graphScreenshotPath = testInfo.outputPath('messages-graph-view.png')
    await page.screenshot({ path: graphScreenshotPath, fullPage: true })
    await testInfo.attach('messages-graph-view', {
      path: graphScreenshotPath,
      contentType: 'image/png'
    })
  })
})
