import { describe, expect, it } from 'vitest'
import { type RawRequest, Request } from '../../src/http/Request.js'
import { Macroable } from '../../src/utils/Macroable.js'

// Module augmentation — the AdonisJS way to type a macro on a framework class.
declare module '../../src/http/Request.js' {
  interface Request {
    wantsHtml(): boolean
  }
}

// A local subclass so macros/getters don't leak onto shared prototypes.
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: class+interface merging IS the Macroable typing pattern (AdonisJS parity) — the whole point of this test.
class Widget extends Macroable {
  value = 10
}
interface Widget {
  twice(n: number): number
  readonly doubled: number
  readonly counted: number
}

describe('Macroable', () => {
  it('macro() adds an instance method', () => {
    Widget.macro('twice', (n: unknown) => Number(n) * 2)
    expect(new Widget().twice(21)).toBe(42)
  })

  it('getter() adds a computed property with access to `this`', () => {
    Widget.getter('doubled', function (this: Widget) {
      return this.value * 2
    })
    expect(new Widget().doubled).toBe(20)
  })

  it('getter(singleton) computes once per instance', () => {
    let calls = 0
    Widget.getter(
      'counted',
      () => {
        calls += 1
        return calls
      },
      true,
    )
    const w = new Widget()
    expect(w.counted).toBe(1)
    expect(w.counted).toBe(1) // cached — not recomputed
    expect(calls).toBe(1)
  })

  it('framework classes (Request) are macroable', () => {
    Request.macro('wantsHtml', function (this: Request) {
      return this.accepts(['html']) === 'html'
    })
    const raw: RawRequest = {
      method: 'GET',
      path: '/',
      query: '',
      headers: { accept: 'text/html' },
      body: '',
    }
    expect(new Request(raw).wantsHtml()).toBe(true)
  })
})
