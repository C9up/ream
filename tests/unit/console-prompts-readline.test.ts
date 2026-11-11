/**
 * What the terminal prompt hands back for a typed line. readline is replaced
 * with one that answers a scripted line, so the real `readLine` runs without
 * a terminal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const typed = vi.hoisted(() => ({ line: '' }))

vi.mock('node:readline', () => ({
  clearLine: () => true,
  cursorTo: () => true,
  createInterface: () => ({
    line: '',
    _writeToOutput: () => {},
    question: (_query: string, answer: (line: string) => void) => answer(typed.line),
    close: () => {},
  }),
}))

const { Prompt } = await import('../../src/console/prompts.js')

let wasTty: boolean | undefined
beforeEach(() => {
  wasTty = process.stdin.isTTY
  process.stdin.isTTY = true
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})
afterEach(() => {
  process.stdin.isTTY = wasTty ?? false
  vi.restoreAllMocks()
})

describe('Prompt > a line typed at the terminal', () => {
  it('keeps the spaces around a secret exactly as typed', async () => {
    typed.line = '  pass phrase  '
    expect(await new Prompt().secure('Password')).toBe('  pass phrase  ')
  })

  it('still trims a plain answer', async () => {
    typed.line = '  Ada  '
    expect(await new Prompt().ask('Name')).toBe('Ada')
  })
})
