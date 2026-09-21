import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { hotReloadCount, hotReloadHappened } from '../../src/dev/hmr.js'

/**
 * What makes a hot swap reach the router.
 *
 * A lazy controller is promoted to a concrete one on first request, and the
 * whole pipeline is cached per route. Both are right in production and both are
 * wrong the moment hot-hook replaces a module: the process keeps serving the
 * class it promoted, so the swap happens and nothing changes — a stable PID and
 * stale output, which is exactly how it was reported.
 *
 * The kernel compares the counter below against the one it stored when it built
 * the entry. These pin the counter's contract; the behaviour itself was proven
 * end to end against a running server: editing an already-served controller
 * changed the response with the PID unchanged, and reverting the kernel to the
 * shipped build made the same edit produce the old body.
 */
describe('hot-swap invalidation', () => {
  it('counts every swap, so a cached pipeline can tell it missed one', () => {
    const before = hotReloadCount()
    hotReloadHappened()
    expect(hotReloadCount()).toBe(before + 1)
    hotReloadHappened()
    expect(hotReloadCount()).toBe(before + 2)
  })

  it('lives on globalThis, because the hot entry is a different module graph', () => {
    // `@c9up/ream/hot` is loaded with `--import`, so a module-level variable
    // would give it a private copy and the running application would never see
    // a swap happen.
    const key = Symbol.for('ream.dev.hotReloadCount')
    const store = globalThis as unknown as Record<symbol, number | undefined>
    expect(store[key]).toBe(hotReloadCount())
  })

  it('reads as zero in a process that never loaded the hot entry', () => {
    // Which is what makes the kernel's check free in production: a number
    // compared against a constant.
    const key = Symbol.for('ream.dev.hotReloadCount')
    const store = globalThis as unknown as Record<symbol, number | undefined>
    const saved = store[key]
    try {
      store[key] = undefined
      expect(hotReloadCount()).toBe(0)
    } finally {
      store[key] = saved
    }
  })
})
