/**
 * `getMode()` tells a provider how far the app intends to go, so it can skip
 * its SIDE EFFECTS when the app is only being inspected — a codegen command
 * should not start queue workers.
 */
import { describe, expect, it } from 'vitest'
import { Application } from '../../src/Application.js'

describe('ream > application mode', () => {
  it('runs for real by default', () => {
    expect(new Application().getMode()).toBe('run')
  })

  it('can be switched before boot', () => {
    const app = new Application()
    expect(app.setMode('warmup').getMode()).toBe('warmup')
  })

  it('refuses to switch after boot', async () => {
    const app = new Application()
    await app.boot()
    // The side effects a provider skipped are already skipped; pretending
    // otherwise would leave the app half-started.
    expect(() => app.setMode('warmup')).toThrow(/already booted/)
  })

  it('lets a provider skip its side effects without changing its bindings', async () => {
    const started: string[] = []
    const app = new Application()
    app.setMode('warmup')
    app.register({
      register() {
        app.container.singleton('queue', async () => ({ name: 'queue' }))
      },
      async start() {
        if (app.getMode() !== 'run') return
        started.push('workers')
      },
    })
    await app.boot()

    // The binding exists either way — the app being inspected has to match
    // the app that runs.
    expect(await app.container.resolve('queue')).toEqual({ name: 'queue' })
    expect(started).toEqual([])
  })
})
