import { describe, expect, it } from 'vitest'
import { HotGraph } from '../../src/dev/hotGraph.js'

/**
 * What a change to one file means for the running process.
 *
 * This decides between swapping a module and restarting, and getting it wrong
 * is worse than having no hot reload at all: a swap that should have been a
 * restart leaves the server answering with code that is no longer on disk,
 * which looks like the edit having no effect.
 */
describe('dev > the hot graph', () => {
  const boundary = '/app/modules/auth/controllers/Login.ts'
  const build = (boundaries: string[] = [boundary], restarts: string[] = []) =>
    new HotGraph({
      isBoundary: (file) => boundaries.includes(file),
      isRestart: (file) => restarts.includes(file),
    })

  it('swaps a boundary and stops there', () => {
    const graph = build()
    graph.link('/bin/server.ts', undefined)
    graph.link(boundary, '/start/routes.ts')
    graph.link('/start/routes.ts', '/bin/server.ts')

    const decision = graph.decide(boundary)
    expect(decision.kind).toBe('swap')
    // The walk stops at the boundary: whoever imports it does so dynamically
    // and will ask for it again. Invalidating its importers too would reach
    // the entry point, which nobody re-imports.
    if (decision.kind === 'swap') expect(decision.invalidated).toEqual([boundary])
  })

  it('carries a file up to the boundary that imports it', () => {
    const graph = build()
    graph.link('/bin/server.ts', undefined)
    graph.link('/start/routes.ts', '/bin/server.ts')
    graph.link(boundary, '/start/routes.ts')
    graph.link('/app/modules/auth/Form.ts', boundary)

    const decision = graph.decide('/app/modules/auth/Form.ts')
    expect(decision.kind).toBe('swap')
    if (decision.kind === 'swap') {
      expect(new Set(decision.invalidated)).toEqual(
        new Set(['/app/modules/auth/Form.ts', boundary]),
      )
    }
  })

  it('restarts when nothing on the way up is a boundary', () => {
    const graph = build()
    graph.link('/bin/server.ts', undefined)
    graph.link('/start/kernel.ts', '/bin/server.ts')

    const decision = graph.decide('/start/kernel.ts')
    expect(decision.kind).toBe('reload')
    if (decision.kind === 'reload') expect(decision.reason).toBe('outside-boundaries')
  })

  it('leaves no version bumped behind when it decides to restart', () => {
    // Deciding before invalidating is the point: a half-invalidated graph
    // would hand out a URL for a module the process never re-imported.
    const graph = build()
    graph.link('/bin/server.ts', undefined)
    graph.link('/start/kernel.ts', '/bin/server.ts')

    graph.decide('/start/kernel.ts')
    expect(graph.version('/start/kernel.ts')).toBe(0)
    expect(graph.version('/bin/server.ts')).toBe(0)
  })

  it('bumps the version so the next resolve fetches the file again', () => {
    const graph = build()
    graph.link(boundary, '/start/routes.ts')
    graph.link('/start/routes.ts', undefined)

    expect(graph.version(boundary)).toBe(0)
    graph.decide(boundary)
    expect(graph.version(boundary)).toBe(1)
    graph.decide(boundary)
    expect(graph.version(boundary)).toBe(2)
  })

  it('restarts for a file on the restart list, whatever the graph says', () => {
    // `.env` is not a module at all: no boundary could ever cover it, and its
    // values are read once at boot.
    const graph = build([boundary], ['/.env'])
    const decision = graph.decide('/.env')
    expect(decision.kind).toBe('reload')
    if (decision.kind === 'reload') expect(decision.reason).toBe('restart-list')
  })

  it('ignores a file the resolver never saw', () => {
    // A README, a fixture, anything the program does not import: reacting to
    // it would restart the server for a change that cannot affect it.
    expect(build().decide('/docs/README.md').kind).toBe('ignore')
  })

  it('terminates on a cycle', () => {
    // Circular imports are legal and do occur; a walk that revisits would hang
    // the dev server on the first save.
    const graph = build(['/a.ts'])
    graph.link('/a.ts', '/b.ts')
    graph.link('/b.ts', '/a.ts')
    expect(graph.decide('/b.ts').kind).toBe('swap')
  })

  it('does not record a module as importing itself', () => {
    const graph = build(['/a.ts'])
    graph.link('/a.ts', '/a.ts')
    // Left alone, a self-edge makes the walk find an importer that is the file
    // itself and never reach a root.
    expect(graph.decide('/a.ts').kind).toBe('swap')
  })
})
