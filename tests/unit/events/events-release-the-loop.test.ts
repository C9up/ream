/**
 * A wildcard subscription or a request handler is not a reason for a process
 * to stay alive.
 *
 * Both were built on STRONG NAPI ThreadsafeFunctions, which keep Node's event
 * loop referenced for as long as the Rust router holds them — so an app that
 * subscribed with `onAny` or registered `onRequest` at preload made every
 * console command hang after it finished. `process.getActiveResourcesInfo()`
 * showed nothing, so it is asserted the only way it can be: by running a real
 * process and seeing whether it ends.
 *
 * And `EventsProvider.shutdown()` releases what the bus holds.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Container } from '../../../src/container/Container.js'
import { Emitter } from '../../../src/events/Emitter.js'
import EventsProvider from '../../../src/events/EventsProvider.js'
import { EventBus } from '../../../src/events/native.js'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
// The child loads the binary itself: the strength of the native callbacks is
// what is under test, and the TypeScript sources need a loader it lacks.
const binary = readdirSync(packageRoot).find((file) =>
  file.startsWith(`events.${process.platform}-${process.arch}`),
)

describe('events > the bus does not hold the process open', () => {
  // Declared only where the binary was built (never skipped — see the CI gate).
  if (binary !== undefined) {
    it('ends a process that subscribed a wildcard listener and a request handler', () => {
      const script = `
        import { createRequire } from 'node:module'
        const require = createRequire(${JSON.stringify(path.join(packageRoot, 'package.json'))})
        const { EventBus } = require(${JSON.stringify(path.join(packageRoot, binary))})
        const bus = new EventBus()
        const seen = []
        bus.subscribe('order.*', (json) => { seen.push(JSON.parse(json).name) })
        bus.onRequest('query:ping', (_json, reply) => reply('pong'))
        await bus.emit('order.created', '{}')
        const answer = await bus.request('query:ping', '{}')
        await new Promise((resolve) => setTimeout(resolve, 100))
        console.log(JSON.stringify({ seen, answer }))
      `
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: packageRoot,
        timeout: 15_000,
        encoding: 'utf8',
      })
      // `signal` is set when the timeout killed it — that IS the hang.
      expect(result.signal).toBeNull()
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('{"seen":["order.created"],"answer":"pong"}')
    })
  }

  it('drops every subscription and request handler on provider shutdown', async () => {
    const container = new Container()
    const provider = new EventsProvider({ container })
    provider.register()
    await provider.boot()
    const emitter = await container.resolve<Emitter>(Emitter)
    const bus = await container.resolve<EventBus>(EventBus)
    await emitter.onAny('a.*', () => {})
    emitter.onRequest('query:x', (_json, reply) => reply('1'))
    emitter.on('a.b', () => {})
    expect(await bus.subscriptionCount()).toBe(1)

    await provider.shutdown()

    expect(await bus.subscriptionCount()).toBe(0)
    expect(emitter.listenerCount()).toBe(0)
    await expect(emitter.request('query:x', {}, 200)).rejects.toThrow(/No request handler/)
  })
})
