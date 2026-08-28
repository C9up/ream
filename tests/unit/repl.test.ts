import { describe, expect, it, vi } from 'vitest'
import { Repl } from '../../src/repl/Repl.js'

/**
 * The application REPL. `node:repl` is the prompt; what makes it an
 * APPLICATION repl is a seeded context, helpers a project registers, and a
 * listing — a prompt full of undiscoverable helpers is a prompt nobody uses.
 */
describe('Repl > helpers', () => {
  it('registers helpers and reports them with their descriptions', () => {
    const repl = new Repl()
      .addMethod('loadModels', () => 'ok', { description: 'Load every entity' })
      .addMethod('q', () => 'ok', { description: 'Run a query', usage: 'q(sql)' })

    const listing = repl.describeMethods()

    expect(listing).toContain('Load every entity')
    expect(listing).toContain('q(sql)')
    // Names are aligned into a column, which is why the width is recorded at
    // registration rather than measured twice.
    const [first, second] = listing.split('\n')
    expect(first?.indexOf('Load')).toBe(second?.indexOf('Run'))
  })

  it('says so when nothing is registered, rather than printing a blank', () => {
    expect(new Repl().describeMethods()).toBe('No methods registered')
  })

  it('replaces a helper registered twice under the same name', () => {
    const repl = new Repl()
      .addMethod('x', () => 'first', { description: 'first' })
      .addMethod('x', () => 'second', { description: 'second' })

    expect(Object.keys(repl.getMethods())).toEqual(['x'])
    expect(repl.describeMethods()).toContain('second')
  })

  it('hands the repl itself to a helper, so it can notify or list', () => {
    const repl = new Repl()
    let received: unknown
    repl.addMethod('probe', (self, ...args) => {
      received = { self, args }
      return 'done'
    })

    const { handler } = repl.getMethods().probe as { handler: (r: Repl, ...a: unknown[]) => unknown }
    expect(handler(repl, 1, 2)).toBe('done')
    expect(received).toEqual({ self: repl, args: [1, 2] })
  })
})

describe('Repl > notify', () => {
  it('wraps the message in newlines so it does not land on the typed line', () => {
    const written: string[] = []
    new Repl({ write: (m) => written.push(m) }).notify('migrated')
    expect(written).toEqual(['\nmigrated\n'])
  })
})

describe('Repl > compiler', () => {
  it('keeps the compiler a host supplies', () => {
    const compiler = { compile: (code: string) => code, supportsTypescript: true }
    const repl = new Repl().useCompiler(compiler)
    expect(repl.compiler).toBe(compiler)
  })
})

describe('Repl > ready', () => {
  it('runs the callbacks only once the prompt exists', () => {
    const repl = new Repl()
    const seen = vi.fn()
    repl.ready(seen)
    // Registering is not starting — a `ready` callback that fired at
    // registration would run before the context was seeded.
    expect(seen).not.toHaveBeenCalled()
  })
})
