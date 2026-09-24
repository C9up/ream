import { describe, expect, it } from 'vitest'
import { fullReloadNotice, invalidatedNotice } from '../../src/dev/fullReload.js'

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

  it('leaves the path uncoloured, and colours only the word', () => {
    // Upstream colours the verb and nothing else, which is what makes a column
    // of these scannable.
    const notice = fullReloadNotice('/project/app/x.ts', 'outside-boundaries', relativise)
    const [, path] = plain(notice).split(' ')
    expect(path).toBe('app/x.ts')
    expect(notice.endsWith('app/x.ts')).toBe(true)
  })
})
