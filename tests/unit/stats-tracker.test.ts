import { describe, expect, it } from 'vitest'
import { StatsTracker } from '../../src/index.js'

describe('StatsTracker', () => {
  it('unknown task returns a zeroed snapshot', () => {
    const s = new StatsTracker()
    expect(s.get('nope')).toEqual({
      lastRunMs: null,
      nextRunMs: null,
      runCount: 0,
      successCount: 0,
      errorCount: 0,
      skippedCount: 0,
      avgDurationMs: 0,
    })
  })

  it('recordStarted updates lastRunMs to the passed instant', () => {
    const s = new StatsTracker()
    s.recordStarted('t', 1_700_000_000_000)
    expect(s.get('t').lastRunMs).toBe(1_700_000_000_000)
  })

  it('two completed runs average their durations', () => {
    const s = new StatsTracker()
    s.recordCompleted('t', 100)
    s.recordCompleted('t', 200)
    const snap = s.get('t')
    expect(snap.runCount).toBe(2)
    expect(snap.successCount).toBe(2)
    expect(snap.errorCount).toBe(0)
    expect(snap.avgDurationMs).toBe(150)
  })

  it('mixed success and failure split counters correctly and roll the average over both', () => {
    const s = new StatsTracker()
    s.recordCompleted('t', 100)
    s.recordFailed('t', 300)
    s.recordCompleted('t', 200)
    const snap = s.get('t')
    expect(snap.runCount).toBe(3)
    expect(snap.successCount).toBe(2)
    expect(snap.errorCount).toBe(1)
    expect(snap.avgDurationMs).toBe(200) // (100+300+200)/3
  })

  it('recordSkipped increments skippedCount + runCount but does NOT touch the average', () => {
    const s = new StatsTracker()
    s.recordCompleted('t', 100)
    s.recordSkipped('t')
    s.recordSkipped('t')
    const snap = s.get('t')
    expect(snap.runCount).toBe(3) // 1 completed + 2 skipped
    expect(snap.successCount).toBe(1)
    expect(snap.skippedCount).toBe(2)
    expect(snap.avgDurationMs).toBe(100) // average over the single completed run
  })

  it('stats are per-task — no cross-leak between names', () => {
    const s = new StatsTracker()
    s.recordCompleted('a', 100)
    s.recordFailed('b', 500)
    const a = s.get('a')
    const b = s.get('b')
    expect(a.successCount).toBe(1)
    expect(a.errorCount).toBe(0)
    expect(a.avgDurationMs).toBe(100)
    expect(b.successCount).toBe(0)
    expect(b.errorCount).toBe(1)
    expect(b.avgDurationMs).toBe(500)
  })

  it('returned snapshot is a defensive copy — mutation does not leak into the tracker', () => {
    const s = new StatsTracker()
    s.recordCompleted('t', 100)
    const snap = s.get('t')
    snap.runCount = 999
    snap.avgDurationMs = 999
    const fresh = s.get('t')
    expect(fresh.runCount).toBe(1)
    expect(fresh.avgDurationMs).toBe(100)
  })
})
