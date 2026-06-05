import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import type { AppContext, ConfigStore } from '../../src/index.js'
import { Container, StaticMiddleware, StaticProvider } from '../../src/index.js'

function buildApp(container: Container): AppContext {
  const config: ConfigStore = { get: () => undefined, set: () => {} }
  return { container, config }
}

describe('StaticProvider', () => {
  it('is a no-op when static is not configured', async () => {
    const container = new Container()
    const provider = new StaticProvider(buildApp(container))
    // No `server` bound — boot must return before resolving it.
    await expect(provider.boot()).resolves.toBeUndefined()
  })

  it('mounts a global StaticMiddleware when configured', async () => {
    const container = new Container()
    const used: unknown[] = []
    container.singleton('server', () => ({
      use(mws: unknown[]): void {
        used.push(...mws)
      },
    }))
    // path.resolve only — no filesystem access at construction.
    const middleware = new StaticMiddleware({ root: '/tmp/ream-static-test' })
    const provider = new StaticProvider(buildApp(container), { middleware })
    await provider.boot()
    expect(used).toHaveLength(1)
  })
})
