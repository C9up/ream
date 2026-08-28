import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { Application } from '../../src/index.js'

/**
 * `Application` was the least covered class of the AdonisJS surface: an app
 * migrating over reads `app.getEnvironment()`, branches on `app.isReady`, and
 * reports `app.toJSON()` from a health endpoint. None of it existed.
 */
describe('Application > environment', () => {
  it('reports the environment a provider branches on', () => {
    // The AdonisJS shape: it lives on the application, because that is where a
    // provider reads it — it used to live only on the Ignitor.
    const app = new Application()
    expect(app.getEnvironment()).toBe('unknown')
    app.setEnvironment('console')
    expect(app.getEnvironment()).toBe('console')
  })

  it('refuses to change environment after boot', async () => {
    // Providers and preloads were already filtered on the old value, so a
    // later change would describe an application that was never assembled.
    const app = new Application()
    app.setEnvironment('web')
    await app.boot()
    expect(() => app.setEnvironment('console')).toThrow(/already booted/)
  })

  it('exposes NODE_ENV separately from the environment', () => {
    // Two different questions: what the process runs AS, and what config it
    // runs UNDER. AdonisJS keeps them apart and so does this.
    expect(typeof new Application().nodeEnvironment).toBe('string')
  })
})

describe('Application > lifecycle state', () => {
  it('walks created → booted → ready', async () => {
    const app = new Application()
    expect(app.getState()).toBe('created')
    expect(app.isReady).toBe(false)
    await app.boot()
    // Ready only AFTER the booted hooks: they are where an app wires what a
    // request needs, so reporting ready before them greens a health check on
    // an application that cannot serve.
    expect(app.getState()).toBe('ready')
    expect(app.isReady).toBe(true)
  })

  it('reaches terminated after shutdown', async () => {
    const app = new Application()
    await app.boot()
    await app.shutdown()
    expect(app.getState()).toBe('terminated')
    expect(app.isTerminated).toBe(true)
    expect(app.isReady).toBe(false)
  })

  it('reports terminated even when a shutdown hook threw', async () => {
    // The hooks all had their turn, so the application IS down. Saying
    // otherwise leaves a supervisor waiting on a shutdown that happened.
    const app = new Application()
    app.onShutdown(() => {
      throw new Error('hook failed')
    })
    await app.boot()
    await expect(app.shutdown()).rejects.toThrow('hook failed')
    expect(app.isTerminated).toBe(true)
  })

  it('sees the booted hook run while the state is still booted', async () => {
    const seen: string[] = []
    const app = new Application()
    app.booted(() => {
      seen.push(app.getState())
    })
    await app.boot()
    expect(seen).toEqual(['booted'])
  })
})

describe('Application > toJSON', () => {
  it('describes the application for a health endpoint', async () => {
    const app = new Application()
    app.setEnvironment('web')
    await app.boot()
    expect(app.toJSON()).toMatchObject({
      environment: 'web',
      state: 'ready',
      isReady: true,
      isTerminating: false,
    })
  })
})

describe('Application > listenOnce', () => {
  it('runs the handler once and stops listening', () => {
    const app = new Application()
    let calls = 0
    app.listenOnce('SIGUSR2', () => {
      calls += 1
    })
    process.emit('SIGUSR2')
    process.emit('SIGUSR2')
    expect(calls).toBe(1)
  })

  it('does nothing when the condition is false', () => {
    const app = new Application()
    let calls = 0
    app.listenOnceIf(false, 'SIGUSR2', () => {
      calls += 1
    })
    process.emit('SIGUSR2')
    expect(calls).toBe(0)
  })
})

describe('Application > importDefault', () => {
  it('returns the default export', async () => {
    const value = await new Application().importDefault<number>(async () => ({ default: 42 }))
    expect(value).toBe(42)
  })

  it('names the file when there is no default export', async () => {
    // Without this the failure surfaces later as "undefined is not a
    // constructor", far from the file at fault.
    await expect(
      new Application().importDefault(async () => ({ named: 1 }), 'start/routes.ts'),
    ).rejects.toThrow(/start\/routes\.ts/)
  })
})
