import { describe, expect, it } from 'vitest'

import { isGraphActiveLoopRow, isPanelActiveLoopRow } from './loop-selectors'
import type { LoopRow } from './loop-state'

function row(overrides: Partial<LoopRow> = {}): LoopRow {
  return {
    active: false,
    childCount: 0,
    children: [],
    commentCount: 0,
    depth: 0,
    parentCount: 0,
    parents: [],
    status: 'todo',
    taskId: 'task-1',
    title: 'Task',
    ...overrides
  }
}

describe('Loop active-row selectors', () => {
  it('preserves the panel definition of active work', () => {
    expect(isPanelActiveLoopRow(row({ status: 'claimed' }))).toBe(true)
    expect(isPanelActiveLoopRow(row({ activeDecompositionChildCount: 1 }))).toBe(true)
    expect(isPanelActiveLoopRow(row({ latestRun: { status: 'running' } }))).toBe(false)
  })

  it("limits graph activity to the task's own work", () => {
    expect(isGraphActiveLoopRow(row({ active: true }))).toBe(true)
    expect(isGraphActiveLoopRow(row({ latestRun: { status: 'running' } }))).toBe(true)
    expect(isGraphActiveLoopRow(row({ activeDecompositionChildCount: 1 }))).toBe(false)
    expect(isGraphActiveLoopRow(row({ status: 'claimed' }))).toBe(false)
  })
})
