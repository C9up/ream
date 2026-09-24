import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseStack, renderError } from '../../src/errors/renderError.js'

/**
 * An error, rendered for someone reading a terminal.
 *
 * Upstream hands this to youch; this is ours. What it owes the reader is the
 * line that failed with the lines around it — a stack alone makes you open the
 * file yourself — and it owes everyone the promise that rendering an error
 * never throws a second one over the first.
 */
describe('errors > the terminal renderer', () => {
  let project: string

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'ream-render-'))
  })
  afterEach(() => {
    rmSync(project, { recursive: true, force: true })
  })

  /** A real error whose stack points at a real file. */
  function thrown(): { error: Error; file: string } {
    const file = join(project, 'orders.ts')
    writeFileSync(
      file,
      ['export function total() {', '  const order = undefined', '  return order.total', '}'].join(
        '\n',
      ),
    )
    const error = new Error("Cannot read properties of undefined (reading 'total')")
    error.stack = [
      `Error: ${error.message}`,
      `    at total (${file}:3:16)`,
      `    at Object.<anonymous> (${file}:1:1)`,
      '    at node:internal/modules/run_main:101:5',
    ].join('\n')
    return { error, file }
  }

  it('shows the failing line with the ones around it', () => {
    const { error } = thrown()

    const out = renderError(error, { cwd: project, colors: false })

    expect(out).toContain('  return order.total')
    expect(out).toContain('const order = undefined')
    // The line number, and a caret under the column the runtime reported.
    expect(out).toMatch(/❯ 3 │ {3}return order\.total/)
    expect(out).toMatch(/\^/)
  })

  it('names the error and says what it said', () => {
    const { error } = thrown()
    const out = renderError(error, { cwd: project, colors: false })
    expect(out).toContain('Error')
    expect(out).toContain("Cannot read properties of undefined (reading 'total')")
  })

  it('prints the path the editor shows', () => {
    const { error } = thrown()
    const out = renderError(error, { cwd: project, colors: false })
    expect(out).toContain('orders.ts:3:16')
    expect(out).not.toContain(project)
  })

  it('keeps the runtime out of the trace', () => {
    // `node:internal/...` is never where the bug is.
    const { error } = thrown()
    const out = renderError(error, { cwd: project, colors: false })
    expect(out).not.toContain('node:internal')
  })

  it('cuts a dependency frame back to its package', () => {
    const error = new Error('boom')
    error.stack = [
      'Error: boom',
      `    at run (${join(project, 'app.ts')}:1:1)`,
      `    at exec (${project}/node_modules/.pnpm/vitest@4.1.11/node_modules/vitest/dist/run.js:302:9)`,
    ].join('\n')

    const out = renderError(error, { cwd: project, colors: false })

    expect(out).toContain('vitest/dist/run.js:302')
    expect(out).not.toContain('.pnpm')
  })

  it('follows the cause, and does not loop on a circular one', () => {
    const root = new Error('the database refused the connection')
    const wrapper = new Error('could not load the dashboard', { cause: root })
    // Errors do get wired in circles, and a renderer that recursed would hang
    // instead of showing either of them.
    Object.defineProperty(root, 'cause', { value: wrapper, configurable: true })

    const out = renderError(wrapper, { cwd: project, colors: false })

    expect(out).toContain('could not load the dashboard')
    expect(out).toContain('caused by')
    expect(out).toContain('the database refused the connection')
  })

  it('still prints when the file is gone', () => {
    // A frame inside a bundle, or a file deleted since the process started.
    const error = new Error('boom')
    error.stack = ['Error: boom', `    at run (${join(project, 'vanished.ts')}:9:1)`].join('\n')

    const out = renderError(error, { cwd: project, colors: false })

    expect(out).toContain('boom')
    expect(out).toContain('vanished.ts:9')
  })

  it('renders something that is not an Error at all', () => {
    expect(renderError('just a string', { colors: false })).toContain('just a string')
    expect(renderError(undefined, { colors: false })).toContain('undefined')
  })

  it('renders an error with no stack', () => {
    const error = new Error('no stack here')
    error.stack = undefined
    expect(renderError(error, { colors: false })).toContain('no stack here')
  })

  it('colours nothing when asked not to', () => {
    const { error } = thrown()
    expect(renderError(error, { cwd: project, colors: false })).not.toMatch(/\u001B\[/)
    expect(renderError(error, { cwd: project, colors: true })).toMatch(/\u001B\[/)
  })

  describe('parsing a stack', () => {
    it('reads both shapes a runtime writes', () => {
      const frames = parseStack(
        [
          'Error: boom',
          '    at named (/app/a.ts:12:3)',
          '    at /app/b.ts:4:1',
          '    at file:///app/c.ts:7:2',
        ].join('\n'),
        '/app',
      )

      expect(frames).toEqual([
        { callee: 'named', file: '/app/a.ts', line: 12, column: 3, origin: 'application' },
        { file: '/app/b.ts', line: 4, column: 1, origin: 'application' },
        // A `file://` URL names the same file as the path.
        { file: '/app/c.ts', line: 7, column: 2, origin: 'application' },
      ])
    })

    it('drops a line that is not a frame rather than guessing', () => {
      const frames = parseStack(
        ['Error: boom', '    at /app/a.ts:1:1', '    something else entirely'].join('\n'),
        '/app',
      )
      expect(frames).toHaveLength(1)
    })

    it('tells the application, a dependency and the runtime apart', () => {
      const frames = parseStack(
        [
          'Error: boom',
          '    at /app/src/a.ts:1:1',
          '    at /app/node_modules/x/b.js:1:1',
          '    at node:internal/modules/run_main:101:5',
        ].join('\n'),
        '/app',
      )
      expect(frames.map((frame) => frame.origin)).toEqual(['application', 'dependency', 'runtime'])
    })
  })
})
