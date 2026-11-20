/**
 * `dd()` dumps and stops THIS piece of work — the request or the command —
 * never the process: in an HTTP server, a `process.exit` would take every other
 * client down with the one being debugged.
 */

import 'reflect-metadata'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BaseCommand } from '../../src/console/BaseCommand.js'
import { Kernel } from '../../src/console/Kernel.js'
import { Dumper, errors } from '../../src/dumper/Dumper.js'
import { Container, createHttpKernel, MiddlewareRegistry, Router } from '../../src/index.js'
import { dd } from '../../src/services/dumper.js'

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = 0
})

describe('dd()', () => {
  it('throws E_DUMP_DIE_EXCEPTION instead of exiting', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })
    let thrown: unknown
    try {
      dd({ a: 1 })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(errors.E_DUMP_DIE_EXCEPTION)
    expect(thrown).toMatchObject({ code: 'E_DUMP_DIE_EXCEPTION', status: 500, value: { a: 1 } })
    expect(exit).not.toHaveBeenCalled()
  })

  it('answers the request with a 500 HTML dump and keeps serving', async () => {
    const router = new Router()
    router.get('/debug', () => dd({ name: '<script>alert(1)</script>' }))
    router.get('/ok', ({ response }) => response.json({ ok: true }))
    const kernel = createHttpKernel({
      router,
      middleware: new MiddlewareRegistry(),
      container: new Container(),
    })
    const request = (path: string) =>
      kernel({ method: 'GET', path, query: '', headers: {}, body: '' })

    const dumped = await request('/debug')
    expect(dumped.status).toBe(500)
    expect(dumped.body).toContain('<!DOCTYPE html>')
    expect(dumped.body).toContain('DUMP DIE')
    expect(dumped.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(dumped.body).not.toContain('<script>alert(1)</script>')
    // The dump names the line that called `dd`, not the service wrapper.
    expect(dumped.body).toContain('dumper-dd.test.ts')

    const next = await request('/ok')
    expect(next.status).toBe(200)
  })

  it('stamps the CSP nonce of the response on the dump styles', async () => {
    const router = new Router()
    router.get('/debug', ({ response }) => {
      response.nonce = 'n0nce'
      return dd('value')
    })
    const kernel = createHttpKernel({
      router,
      middleware: new MiddlewareRegistry(),
      container: new Container(),
    })
    const dumped = await kernel({ method: 'GET', path: '/debug', query: '', headers: {}, body: '' })
    expect(dumped.body).toContain('<style nonce="n0nce">')
  })

  it('is not reported to the logger', async () => {
    const error = new errors.E_DUMP_DIE_EXCEPTION('x', new Dumper())
    expect(error.report()).toBeUndefined()
  })

  it('prints the ANSI dump through the console kernel and fails the command', async () => {
    class Debug extends BaseCommand {
      static override commandName = 'debug'
      static override description = 'Dumps and dies'
      run(): never {
        return dd({ answer: 42 })
      }
    }
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })
    let buffer = ''
    const write = (chunk: string | Uint8Array): boolean => {
      buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
      return true
    }
    vi.spyOn(process.stdout, 'write').mockImplementation(write)
    vi.spyOn(process.stderr, 'write').mockImplementation(write)

    const kernel = new Kernel().register(Debug)
    await kernel.handle(['debug'])

    expect(buffer).toContain('DUMP DIE')
    expect(buffer).toContain('answer')
    expect(buffer).toContain('42')
    expect(kernel.exitCode).toBe(1)
    expect(exit).not.toHaveBeenCalled()
  })
})
