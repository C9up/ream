import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleKey, helpLines, installShortcuts } from '../../src/dev/shortcuts.js'

/**
 * The keys the dev server answers to.
 *
 * Upstream's set: `r` restarts, `c` clears, `o` opens the browser, `h` lists
 * them, Ctrl-C and Ctrl-D quit. Raw mode means no signal is raised for the
 * last two, so without them the process would sit there unkillable.
 */
describe('dev > the keyboard shortcuts', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('lists the same four keys upstream lists, in the same order', () => {
    expect(helpLines()).toEqual([
      'Available shortcuts:',
      '· r: restart server',
      '· c: clear console',
      '· o: open in browser',
      '· h: show this help',
    ])
  })

  it('restarts on `r`', () => {
    // Exiting on the restart code IS the restart: the parent loops on it.
    const onRestart = vi.fn()
    expect(handleKey('r', { onRestart })).toBe(true)
    expect(onRestart).toHaveBeenCalledOnce()
  })

  it('quits on Ctrl-C and on Ctrl-D', () => {
    const onQuit = vi.fn()
    expect(handleKey('\u0003', { onQuit })).toBe(true)
    expect(handleKey('\u0004', { onQuit })).toBe(true)
    expect(onQuit).toHaveBeenCalledTimes(2)
  })

  it('ignores a key nobody bound', () => {
    const onRestart = vi.fn()
    const onQuit = vi.fn()
    expect(handleKey('z', { onRestart, onQuit })).toBe(false)
    expect(onRestart).not.toHaveBeenCalled()
    expect(onQuit).not.toHaveBeenCalled()
  })

  it('answers `h` and `c` without needing an address', () => {
    // They act on this terminal, not on the server.
    expect(handleKey('h')).toBe(true)
    expect(handleKey('c')).toBe(true)
  })

  it('says so rather than opening nothing', () => {
    // `o` with no address is a misconfiguration, not a crash.
    expect(handleKey('o', {})).toBe(true)
  })

  it('listens to no keyboard when there is none', () => {
    // `ream dev` piped into a file has no terminal, and raw mode on a pipe
    // throws. A no-op remover means `stop()` need not care which it was.
    const stdin = process.stdin
    const isTTY = stdin.isTTY
    try {
      Object.defineProperty(stdin, 'isTTY', { value: false, configurable: true })
      const remove = installShortcuts({ url: 'http://localhost:3000' })
      expect(remove).toBeTypeOf('function')
      expect(() => remove()).not.toThrow()
    } finally {
      Object.defineProperty(stdin, 'isTTY', { value: isTTY, configurable: true })
    }
  })

  it('puts the terminal back when it stops listening', () => {
    // Left in raw mode, it swallows the next command you type — and that
    // outlives the process.
    const stdin = process.stdin
    const isTTY = stdin.isTTY
    const setRawMode = vi.fn()
    try {
      Object.defineProperty(stdin, 'isTTY', { value: true, configurable: true })
      Object.defineProperty(stdin, 'setRawMode', { value: setRawMode, configurable: true })

      const remove = installShortcuts()
      expect(setRawMode).toHaveBeenCalledWith(true)
      remove()
      expect(setRawMode).toHaveBeenLastCalledWith(false)
    } finally {
      Object.defineProperty(stdin, 'isTTY', { value: isTTY, configurable: true })
      Reflect.deleteProperty(stdin, 'setRawMode')
    }
  })
})
