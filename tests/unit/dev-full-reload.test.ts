import { describe, expect, it } from 'vitest'
import { clearScreen, fullReloadNotice, invalidatedNotice } from '../../src/dev/fullReload.js'

/**
 * What the dev server says when a file changed.
 *
 * Upstream's two words, read off `@adonisjs/assembler`'s build: a module
 * swapped in place is `invalidated <path>`, one that forced a restart is
 * `update <path>`. Without either, the only trace of a restart was the boot
 * banner appearing twice, which reads as a server rebooting on its own.
 */
describe('dev > what a change prints', () => {
  const relativise = (file: string) => file.replace('/project/', '')
  const plain = (line: string) => line.replace(/\u001B\[\d+m/g, '')

  it('says `update` and the file, when the process must restart', () => {
    const notice = fullReloadNotice('/project/start/kernel.ts', 'outside-boundaries', relativise)
    expect(plain(notice)).toBe('update start/kernel.ts')
  })

  it('says the same for a file on the restart list', () => {
    // `.env` is not a module, so no boundary could ever cover it — but the
    // developer is told the same thing either way: it changed, and the server
    // came back.
    const notice = fullReloadNotice('/project/.env', 'restart-list', relativise)
    expect(plain(notice)).toBe('update .env')
  })

  it('says `invalidated` and the file, when the module was swapped', () => {
    const notice = invalidatedNotice('/project/app/billing/InvoiceController.ts', relativise)
    expect(plain(notice)).toBe('invalidated app/billing/InvoiceController.ts')
  })

  it('shows the path the editor shows, not the absolute one', () => {
    expect(
      plain(fullReloadNotice('/project/app/x.ts', 'outside-boundaries', relativise)),
    ).not.toContain('/project/')
  })

  it('clears the terminal only when there is one, and not with --no-clear', () => {
    // Upstream writes the reset before the restart line so what follows is the
    // only thing on screen. Into a pipe it would just leave escape codes in
    // the file, and `--no-clear` is the flag that says do not.
    const written: string[] = []
    const stdout = process.stdout
    const restore = { isTTY: stdout.isTTY, write: stdout.write }
    const previous = process.env.REAM_DEV_CLEAR_SCREEN

    try {
      Object.defineProperty(stdout, 'isTTY', { value: true, configurable: true })
      Object.defineProperty(stdout, 'write', {
        value: (chunk: string) => {
          written.push(chunk)
          return true
        },
        configurable: true,
      })

      delete process.env.REAM_DEV_CLEAR_SCREEN
      clearScreen()
      expect(written).toEqual(['\u001Bc'])

      written.length = 0
      process.env.REAM_DEV_CLEAR_SCREEN = 'false'
      clearScreen()
      expect(written).toEqual([])

      written.length = 0
      delete process.env.REAM_DEV_CLEAR_SCREEN
      Object.defineProperty(stdout, 'isTTY', { value: false, configurable: true })
      clearScreen()
      expect(written).toEqual([])
    } finally {
      Object.defineProperty(stdout, 'isTTY', { value: restore.isTTY, configurable: true })
      Object.defineProperty(stdout, 'write', { value: restore.write, configurable: true })
      if (previous === undefined) delete process.env.REAM_DEV_CLEAR_SCREEN
      else process.env.REAM_DEV_CLEAR_SCREEN = previous
    }
  })

  it('leaves the path uncoloured, and colours only the word', () => {
    // Upstream colours the verb and nothing else, which is what makes a column
    // of these scannable.
    const notice = fullReloadNotice('/project/app/x.ts', 'outside-boundaries', relativise)
    const [, path] = plain(notice).split(' ')
    expect(path).toBe('app/x.ts')
    expect(notice.endsWith('app/x.ts')).toBe(true)
  })
})
