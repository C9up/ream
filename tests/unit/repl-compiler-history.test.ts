/**
 * The prompt runs typed code through the host's compiler and keeps a history
 * file, as `@adonisjs/repl` does.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { Repl } from '../../src/repl/Repl.js'

const dirs: string[] = []
const repls: Repl[] = []

afterEach(() => {
  for (const repl of repls.splice(0)) repl.server?.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function startRepl(options: ConstructorParameters<typeof Repl>[0] = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  let printed = ''
  output.on('data', (chunk: Buffer) => {
    printed += chunk.toString()
  })
  const repl = new Repl({ input, output, terminal: true, write: () => {}, ...options })
  repls.push(repl)
  return { repl, input, printed: () => printed }
}

async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function type(input: PassThrough, line: string): Promise<void> {
  input.write(`${line}\n`)
  await new Promise((resolve) => setTimeout(resolve, 30))
}

describe('Repl > compiler', () => {
  it('compiles typed code before evaluating it', async () => {
    const seen: string[] = []
    const compiler = {
      supportsTypescript: true,
      compile: (code: string) => {
        seen.push(code)
        return code.replace(': number', '')
      },
    }
    const { repl, input, printed } = startRepl()
    repl.useCompiler(compiler).start()
    await type(input, 'const answer: number = 41')
    await type(input, 'answer + 1')
    await until(() => printed().includes('42'))
    expect(seen.some((code) => code.includes('const answer: number = 41'))).toBe(true)
    expect(printed()).toContain('42')
    expect(printed()).not.toContain('SyntaxError')
  })

  it('takes the compiler as a constructor option too', async () => {
    const { repl, input, printed } = startRepl({
      compiler: { supportsTypescript: true, compile: (code) => code.replace('<x>', '20') },
    })
    repl.start()
    await type(input, '<x> + 22')
    await until(() => printed().includes('42'))
    expect(printed()).toContain('42')
  })

  it('keeps multi-line input open on an incomplete statement', async () => {
    const { repl, input, printed } = startRepl({
      compiler: { supportsTypescript: true, compile: (code) => code },
    })
    repl.start()
    await type(input, 'function add(a, b) {')
    await type(input, '  return a + b }')
    await type(input, 'add(40, 2)')
    await until(() => printed().includes('42'))
    expect(printed()).toContain('42')
    expect(printed()).not.toContain('SyntaxError')
  })
})

describe('Repl > history', () => {
  it('persists the entered lines to historyFilePath', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ream-repl-'))
    dirs.push(dir)
    const historyFilePath = join(dir, 'history')
    const { repl, input } = startRepl({ historyFilePath })
    repl.start()
    // Node opens the history file asynchronously; a line typed before that
    // lands in a history the setup then replaces.
    await until(() => existsSync(historyFilePath))
    await type(input, '1 + 41')
    repl.server?.close()
    await until(() => readFileSync(historyFilePath, 'utf8').includes('1 + 41'))
    expect(readFileSync(historyFilePath, 'utf8')).toContain('1 + 41')
  })
})
