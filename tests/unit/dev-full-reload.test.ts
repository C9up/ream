/**
 * The line that says why the dev server is restarting.
 *
 * Its failure modes are both silent: saying nothing (the banner reappears with
 * no explanation, which is what this exists to stop) and saying it for a
 * message that is not a full reload (a hot swap would look like a restart).
 */
import { describe, expect, it } from 'vitest'
import { fullReloadNotice } from '../../src/dev/fullReload.js'

const shown = (file: string): string => file.replace('/project/', '')

describe('dev > the full reload notice', () => {
  it('names the file hot-hook could not swap', () => {
    const notice = fullReloadNotice(
      { type: 'hot-hook:full-reload', path: '/project/app/services/Billing.ts' },
      shown,
    )

    expect(notice).toContain('app/services/Billing.ts')
  })

  it('reads the `paths` shape a declined module sends', () => {
    // Same outcome, different message: hot-hook raises a full reload with
    // `paths` when a module refused hot replacement.
    const notice = fullReloadNotice(
      { type: 'hot-hook:full-reload', paths: ['/project/start/routes.ts'] },
      shown,
    )

    expect(notice).toContain('start/routes.ts')
  })

  it('points at the import when the boundary was right', () => {
    // The file matches a boundary and STILL forced a restart: the fix is the
    // static import reaching it, not the glob.
    const notice = fullReloadNotice(
      {
        type: 'hot-hook:full-reload',
        path: '/project/app/controllers/HomeController.ts',
        shouldBeReloadable: true,
      },
      shown,
    )

    expect(notice).toContain('statically')
  })

  it('stays quiet about a file it was given none of', () => {
    const notice = fullReloadNotice({ type: 'hot-hook:full-reload' }, shown)

    expect(notice).toBeDefined()
    expect(notice).not.toContain('undefined')
  })

  it('says nothing for a hot swap', () => {
    // A swap keeps the process: printing a restart line for it would describe
    // the opposite of what happened.
    expect(
      fullReloadNotice({ type: 'hot-hook:invalidated', paths: ['/a.ts'] }, shown),
    ).toBeUndefined()
  })

  it('says nothing for anything else a process can send', () => {
    expect(fullReloadNotice(undefined, shown)).toBeUndefined()
    expect(fullReloadNotice(null, shown)).toBeUndefined()
    expect(fullReloadNotice('hot-hook:full-reload', shown)).toBeUndefined()
    expect(fullReloadNotice({ hello: 'world' }, shown)).toBeUndefined()
  })
})
