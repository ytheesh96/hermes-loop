import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { type MockBackendFixture, setupMockBackend, waitForAppReady } from './fixtures'
import { MOCK_REPLY } from './mock-server'
import { expect, type Page, test } from './test'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const SURFACE = '[data-composer-target]:not([data-pane-hidden] [data-composer-target])'
const PROMPT = 'E2E task feed side-by-side source session.'

async function showSessionTab(page: Page): Promise<void> {
  await page.locator('[role="tab"][data-tree-tab="workspace"]').click()
  await expect(page.locator(SURFACE).last()).toBeVisible()
}

async function showSessionFromSidebar(page: Page): Promise<void> {
  await page.getByRole('button', { name: MOCK_REPLY, exact: true }).click()
  await expect(page.locator(SURFACE).last()).toBeVisible()
}

async function send(page: Page, text: string): Promise<void> {
  const composer = page.locator(SURFACE).last().locator('[contenteditable="true"]').first()
  await composer.waitFor({ state: 'visible', timeout: 15_000 })
  await composer.fill(text)
  await page.keyboard.press('Enter')
}

async function currentSessionId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const desktopWindow = window as typeof window & {
      hermesDesktop: { api: <T>(request: unknown) => Promise<T> }
    }
    const result = await desktopWindow.hermesDesktop.api<{ sessions: Array<{ id: string }> }>({
      path: '/api/sessions?limit=1&offset=0&min_messages=1&archived=exclude&order=recent',
    })

    if (!result.sessions[0]?.id) {
      throw new Error('No persisted source session')
    }

    return result.sessions[0].id
  })
}

function seedTask(fixture: MockBackendFixture, sessionId: string): { commentId: number; taskId: string } {
  const script = String.raw`
import json
from hermes_cli import kanban_db

conn = kanban_db.connect(board="default")
try:
    task_id = kanban_db.create_task(conn, title="Side-by-side source task", session_id=${JSON.stringify(sessionId)})
    comment_id = kanban_db.add_comment(conn, task_id, "Builder", "SIDE_BY_SIDE_COMMENT")
    print(json.dumps({"taskId": task_id, "commentId": comment_id}))
finally:
    conn.close()
`
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fixture.sandbox.root,
    HERMES_HOME: fixture.sandbox.hermesHome,
  }
  delete env.HERMES_KANBAN_DB
  delete env.HERMES_KANBAN_BOARD
  const result = spawnSync('uv', ['run', 'python', '-c', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
  })
  if (result.status !== 0) {
    throw new Error(`Failed to seed task feed fixture:\n${result.stderr}`)
  }

  return JSON.parse(result.stdout.trim()) as { commentId: number; taskId: string }
}

async function paneGroupIds(page: Page, paneIds: string[]): Promise<Record<string, string | null>> {
  return page.evaluate(ids => {
    const raw = localStorage.getItem('hermes.desktop.layoutTree.v2')
    const tree = raw ? (JSON.parse(raw) as unknown) : null
    const result = Object.fromEntries(ids.map(id => [id, null])) as Record<string, string | null>

    const visit = (node: unknown) => {
      if (!node || typeof node !== 'object') {
        return
      }

      const value = node as { active?: string; children?: unknown[]; id?: string; panes?: string[] }
      for (const paneId of value.panes ?? []) {
        if (paneId in result) {
          result[paneId] = value.id ?? null
        }
      }

      for (const child of value.children ?? []) {
        visit(child)
      }
    }

    visit(tree)

    return result
  }, paneIds)
}

test.describe('task feed composer side-by-side placement', () => {
  test.setTimeout(180_000)

  let fixture: MockBackendFixture | null = null

  test.beforeEach(async () => {
    fixture = await setupMockBackend()
    await waitForAppReady(fixture, 120_000)
  })

  test.afterEach(async () => {
    await fixture?.cleanup()
    fixture = null
  })

  test('keeps chat visible, deduplicates re-clicks, and uses the narrow tab fallback', async ({}, testInfo) => {
    const { page } = fixture!
    await page.setViewportSize({ width: 1440, height: 900 })
    await send(page, PROMPT)
    await expect(page.locator(SURFACE).last()).toContainText(MOCK_REPLY, { timeout: 30_000 })
    const sessionId = await currentSessionId(page)
    const seed = seedTask(fixture!, sessionId)

    const launcher = page.locator('.task-feed-launcher-row')
    await launcher.waitFor({ state: 'visible', timeout: 15_000 })
    await launcher.click()

    const feedTab = page.getByRole('tab', { name: new RegExp(`Task feed.*${MOCK_REPLY}`) })
    await expect(feedTab).toHaveCount(1)
    const feed = page.getByTestId('scoped-task-feed-pane')
    await expect(feed).toBeVisible()
    await expect(page.getByTestId('live-graph-canvas')).toHaveCount(0)
    await expect(page.getByTestId('live-graph-task-feed')).toHaveCount(0)
    await expect(feed.getByRole('button', { name: 'Tasks' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator(SURFACE).last()).toBeVisible()

    const feedPaneId = await feedTab.getAttribute('data-pane-id')
    const paneId = feedPaneId || `live-graph:feed:default:${sessionId}`
    const wideGroups = await paneGroupIds(page, ['workspace', paneId])
    expect(wideGroups.workspace).not.toBe(wideGroups[paneId])

    await launcher.click({ modifiers: ['Shift'] })
    const shiftCenterGroups = await paneGroupIds(page, ['workspace', paneId])
    expect(shiftCenterGroups.workspace).toBe(shiftCenterGroups[paneId])
    await showSessionTab(page)
    await launcher.click()
    const restoredWideGroups = await paneGroupIds(page, ['workspace', paneId])
    expect(restoredWideGroups.workspace).not.toBe(restoredWideGroups[paneId])

    await feed.getByRole('button', { exact: true, name: 'Messages' }).click()
    await expect(feed.getByText('SIDE_BY_SIDE_COMMENT')).toBeVisible({ timeout: 30_000 })
    await launcher.click()
    await expect(page.getByRole('tab', { name: /Task feed/ })).toHaveCount(1)
    await expect(feed.getByRole('button', { exact: true, name: 'Messages' })).toHaveAttribute('aria-pressed', 'true')

    const wideScreenshot = testInfo.outputPath('task-feed-chat-side-by-side.png')
    await page.screenshot({ path: wideScreenshot, fullPage: true })
    await testInfo.attach('task-feed-chat-side-by-side', { path: wideScreenshot, contentType: 'image/png' })

    await feedTab.dragTo(page.locator(SURFACE).last())
    const manuallyStackedGroups = await paneGroupIds(page, ['workspace', paneId])
    expect(manuallyStackedGroups.workspace).toBe(manuallyStackedGroups[paneId])
    await showSessionFromSidebar(page)
    await launcher.click()
    const preservedManualGroups = await paneGroupIds(page, ['workspace', paneId])
    expect(preservedManualGroups).toEqual(manuallyStackedGroups)
    await expect(page.getByRole('tab', { name: /Task feed/ })).toHaveCount(1)

    await showSessionFromSidebar(page)
    await launcher.click({ modifiers: ['Shift'] })
    const preservedManualCenterGroups = await paneGroupIds(page, ['workspace', paneId])
    expect(preservedManualCenterGroups).toEqual(manuallyStackedGroups)
    await expect(page.getByRole('tab', { name: /Task feed/ })).toHaveCount(1)

    await page.keyboard.press('Meta+W')
    await expect(page.getByRole('tab', { name: /Task feed/ })).toHaveCount(0)
    await expect(page.locator(SURFACE).last()).toBeVisible()

    await launcher.click()
    await expect(page.getByRole('tab', { name: /Task feed/ })).toHaveCount(1)
    await expect(
      page.getByTestId('scoped-task-feed-pane').getByRole('button', { exact: true, name: 'Tasks' })
    ).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    await page.getByRole('button', { name: /Close Task feed/ }).click()
    await page.setViewportSize({ width: 1024, height: 900 })
    await launcher.click()
    const narrowGroups = await paneGroupIds(page, ['workspace', paneId])
    expect(narrowGroups.workspace).toBe(narrowGroups[paneId])
    await expect(page.locator('[data-composer-target]')).toHaveCount(1)
    await expect(page.locator(SURFACE)).toHaveCount(0)
    await expect(page.getByTestId('scoped-task-feed-pane')).toBeVisible()

    const narrowScreenshot = testInfo.outputPath('task-feed-narrow-tab-fallback.png')
    await page.screenshot({ path: narrowScreenshot, fullPage: true })
    await testInfo.attach('task-feed-narrow-tab-fallback', { path: narrowScreenshot, contentType: 'image/png' })

    await showSessionTab(page)

    const rawEvidencePath = testInfo.outputPath('task-feed-side-by-side-evidence.json')
    fs.writeFileSync(
      rawEvidencePath,
      JSON.stringify(
        {
          sessionId,
          seed,
          paneId,
          wideGroups,
          shiftCenterGroups,
          restoredWideGroups,
          manuallyStackedGroups,
          preservedManualGroups,
          preservedManualCenterGroups,
          narrowGroups,
        },
        null,
        2
      ),
    )
    await testInfo.attach('task-feed-side-by-side-evidence', {
      path: rawEvidencePath,
      contentType: 'application/json',
    })
  })
})
