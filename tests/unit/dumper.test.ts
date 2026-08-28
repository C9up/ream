import { describe, expect, it } from 'vitest'
import { Dumper } from '../../src/dumper/Dumper.js'

describe('Dumper > ANSI', () => {
  it('walks nested values and reports circular references', () => {
    const dumper = new Dumper().configureAnsiOutput({ colors: false })
    const node: Record<string, unknown> = { name: 'root' }
    node.self = node

    const out = dumper.dumpToAnsi(node)

    expect(out).toContain("name: 'root'")
    // A dump of a graph must terminate and say why, not stack-overflow.
    expect(out).toContain('[Circular')
  })

  it('does not truncate the long values someone is dumping to see', () => {
    const dumper = new Dumper().configureAnsiOutput({ colors: false })
    const long = 'x'.repeat(500)

    const out = dumper.dumpToAnsi({ long, many: Array.from({ length: 200 }, (_, i) => i) })

    expect(out).toContain(long)
    expect(out).toContain('199')
    expect(out).not.toContain('more item')
  })

  it('prefixes the title and the source when given', () => {
    const dumper = new Dumper().configureAnsiOutput({ colors: false })
    const out = dumper.dumpToAnsi(
      { a: 1 },
      { title: 'payload', source: { location: '/app/x.ts', line: 12 } },
    )
    expect(out.split('\n')[0]).toBe('payload — /app/x.ts:12')
  })

  it('honours the configured depth', () => {
    const deep = { a: { b: { c: { d: { e: 'bottom' } } } } }
    expect(
      new Dumper().configureAnsiOutput({ colors: false, depth: 1 }).dumpToAnsi(deep),
    ).toContain('[Object]')
    expect(
      new Dumper().configureAnsiOutput({ colors: false, depth: 8 }).dumpToAnsi(deep),
    ).toContain("e: 'bottom'")
  })
})

describe('Dumper > HTML', () => {
  it('escapes the dumped value — it is data someone else may control', () => {
    const dumper = new Dumper()
    const out = dumper.dumpToHtml({ '<img src=x onerror=alert(1)>': '</pre><script>' })

    // The whole point: a dump is reached for mid-debug, which is exactly when
    // a script tag hiding in a field name would be least expected.
    expect(out).not.toContain('<script>')
    expect(out).not.toContain('<img src=x')
    expect(out).toContain('&lt;script&gt;')
  })

  it('attributes the style tag to the CSP nonce it is given', () => {
    const out = new Dumper().dumpToHtml({ a: 1 }, { cspNonce: 'abc123' })
    // Without the nonce a page on a nonce-based policy drops the styling
    // silently, and the dump lands unreadable.
    expect(out).toContain('<style nonce="abc123">')
  })

  it('emits no nonce attribute when none is supplied', () => {
    expect(new Dumper().dumpToHtml({ a: 1 })).toContain('<style>')
  })

  it('lets a caller override the styles without losing the rest', () => {
    const out = new Dumper().configureHtmlOutput({ styles: { color: 'red' } }).dumpToHtml({ a: 1 })
    expect(out).toContain('color: red;')
    expect(out).toContain('padding: 1rem;')
  })
})
