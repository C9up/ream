import { describe, expect, it } from 'vitest'
import { fullReloadNotice } from '../../src/dev/fullReload.js'

/**
 * The line printed before the dev server restarts.
 *
 * Without it the only trace of a full reload was the boot banner appearing
 * twice, which reads as a server rebooting on its own rather than as a file
 * that fell outside the declared boundaries.
 */
describe('dev > the full reload notice', () => {
  const relativise = (file: string) => file.replace('/project/', '')

  it('names the file that could not be swapped', () => {
    const notice = fullReloadNotice('/project/start/kernel.ts', 'outside-boundaries', relativise)
    expect(notice).toContain('start/kernel.ts')
    expect(notice).toContain('full reload')
  })

  it('says when nothing importing the file was inside a boundary', () => {
    const notice = fullReloadNotice(
      '/project/app/services/Mailer.ts',
      'outside-boundaries',
      relativise,
    )
    expect(notice).toContain('hotHook.boundaries')
  })

  it('distinguishes a file that always restarts', () => {
    // `.env` is on the restart list: it is not a module, so no boundary could
    // ever cover it, and blaming the boundaries would send the reader looking
    // for a glob to fix.
    const notice = fullReloadNotice('/project/.env', 'restart-list', relativise)
    expect(notice).toContain('hotHook.restart')
    expect(notice).not.toContain('boundaries')
  })

  it('shows the path the editor shows, not the absolute one', () => {
    expect(fullReloadNotice('/project/app/x.ts', 'outside-boundaries', relativise)).not.toContain(
      '/project/',
    )
  })
})
