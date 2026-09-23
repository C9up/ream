import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Watcher, watchProject } from '../../src/dev/hotWatcher.js'

/**
 * What the dev server notices on disk.
 *
 * The case that matters is the one that shipped broken in 0.2.26: most editors
 * save by writing a temporary file and renaming it over the original, which
 * gives the path a new inode. A watcher holding the old one reports the first
 * save and then nothing — no reload, no restart, no message — so the page keeps
 * serving code that is no longer on disk.
 */

/** Write the way JetBrains IDEs and most formatters do: temp file, then rename. */
function atomicWrite(file: string, contents: string): void {
  const temporary = `${file}.tmp${Math.random().toString(36).slice(2)}`
  fs.writeFileSync(temporary, contents)
  fs.renameSync(temporary, file)
}

async function waitFor(condition: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Long enough for an event that should NOT arrive to have arrived. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300))
}

describe('dev > the project watcher', () => {
  let root: string
  let watcher: Watcher | undefined
  let changed: string[]
  let warnings: string[]

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ream-watcher-'))
    changed = []
    warnings = []
  })

  afterEach(() => {
    watcher?.close()
    watcher = undefined
    fs.rmSync(root, { recursive: true, force: true })
  })

  function start(directories: string[], files: string[] = []): void {
    watcher = watchProject({
      root,
      directories,
      files,
      onChange: (file) => changed.push(path.relative(root, file)),
      onWarning: (message) => warnings.push(message),
    })
  }

  it('reports EVERY save an editor makes by renaming over the file', async () => {
    // The regression: the first rename was reported and every one after it was
    // dropped, because the watcher was holding the replaced inode.
    fs.mkdirSync(path.join(root, 'app'))
    const target = path.join(root, 'app', 'LoginController.ts')
    fs.writeFileSync(target, 'export const v = 0\n')
    start(['app'])

    for (let pass = 1; pass <= 3; pass++) {
      atomicWrite(target, `export const v = ${pass}\n`)
      await waitFor(() => changed.length >= pass)
      expect(changed.length, `save #${pass} was not reported`).toBeGreaterThanOrEqual(pass)
    }
    expect(new Set(changed)).toEqual(new Set(['app/LoginController.ts']))
  })

  it('reports a plain in-place write too', async () => {
    fs.mkdirSync(path.join(root, 'app'))
    const target = path.join(root, 'app', 'Service.ts')
    fs.writeFileSync(target, 'a')
    start(['app'])

    fs.writeFileSync(target, 'b')
    await waitFor(() => changed.length > 0)
    expect(changed).toContain('app/Service.ts')
  })

  it('does not report the temporary file an atomic save leaves behind', async () => {
    fs.mkdirSync(path.join(root, 'app'))
    const target = path.join(root, 'app', 'Controller.ts')
    fs.writeFileSync(target, 'a')
    start(['app'])

    atomicWrite(target, 'b')
    await waitFor(() => changed.length > 0)
    await settle()
    // `Controller.ts.tmp8f3` is a file the graph has never heard of, on its way
    // to becoming the one that matters.
    expect(changed.every((file) => !/\.tmp/.test(file))).toBe(true)
  })

  it('watches a directory created after it started', async () => {
    fs.mkdirSync(path.join(root, 'app'))
    start(['app'])

    fs.mkdirSync(path.join(root, 'app', 'billing'))
    const target = path.join(root, 'app', 'billing', 'InvoiceController.ts')
    await waitFor(() => fs.existsSync(path.dirname(target)))
    fs.writeFileSync(target, 'export class InvoiceController {}')

    await waitFor(() => changed.some((file) => file.endsWith('InvoiceController.ts')))
    expect(changed.some((file) => file.endsWith('InvoiceController.ts'))).toBe(true)
  })

  it('sees an env file replaced by a rename', async () => {
    // A single file is watched through its parent directory for the same
    // reason: `.env` is saved by the same editors as everything else.
    const env = path.join(root, '.env')
    fs.writeFileSync(env, 'APP_KEY=a')
    start([], ['.env'])

    for (let pass = 1; pass <= 2; pass++) {
      atomicWrite(env, `APP_KEY=${pass}`)
      await waitFor(() => changed.length >= pass)
    }
    expect(changed.length).toBeGreaterThanOrEqual(2)
    expect(new Set(changed)).toEqual(new Set(['.env']))
  })

  it('reports nothing for a file it was not asked about', async () => {
    const env = path.join(root, '.env')
    fs.writeFileSync(env, 'A=1')
    fs.writeFileSync(path.join(root, 'other.txt'), 'x')
    start([], ['.env'])

    fs.writeFileSync(path.join(root, 'other.txt'), 'y')
    await settle()
    expect(changed).toEqual([])
  })

  it('stays quiet about a directory the project does not have', async () => {
    // The list is the framework's conventional layout, not a requirement.
    start(['app', 'database', 'providers'])
    await settle()
    expect(warnings).toEqual([])
  })

  it('stops reporting once closed', async () => {
    fs.mkdirSync(path.join(root, 'app'))
    const target = path.join(root, 'app', 'A.ts')
    fs.writeFileSync(target, 'a')
    start(['app'])
    watcher?.close()
    watcher = undefined

    atomicWrite(target, 'b')
    await settle()
    expect(changed).toEqual([])
  })
})
