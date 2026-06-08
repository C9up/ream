/**
 * LocalDriver path-traversal regression. Without `assertWithinRoot`,
 * `../secrets.env` and friends would let a caller read / write /
 * delete arbitrary files outside the configured storage root.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDriver } from '../../src/storage/StorageManager.js'

let rootDir: string
let parentDir: string

beforeEach(() => {
  parentDir = mkdtempSync(join(tmpdir(), 'ream-storage-traversal-'))
  rootDir = join(parentDir, 'storage')
})

afterEach(() => {
  rmSync(parentDir, { recursive: true, force: true })
})

describe('LocalDriver > path traversal containment', () => {
  it('put refuses paths that escape the root (../)', async () => {
    const driver = new LocalDriver(rootDir)
    // Plant a sibling file we should NOT be able to overwrite.
    const sibling = join(parentDir, 'secrets.env')
    writeFileSync(sibling, 'KEY=original')

    await expect(driver.put('../secrets.env', 'KEY=pwned')).rejects.toThrow(/E_PATH_TRAVERSAL/)
  })

  it('get refuses paths that escape the root', async () => {
    const driver = new LocalDriver(rootDir)
    const sibling = join(parentDir, 'secrets.env')
    writeFileSync(sibling, 'KEY=secret')

    await expect(driver.get('../secrets.env')).rejects.toThrow(/E_PATH_TRAVERSAL/)
  })

  it('delete refuses paths that escape the root', async () => {
    const driver = new LocalDriver(rootDir)
    const sibling = join(parentDir, 'secrets.env')
    writeFileSync(sibling, 'KEY=secret')

    await expect(driver.delete('../secrets.env')).rejects.toThrow(/E_PATH_TRAVERSAL/)
  })

  it('exists reports false for traversal attempts (no information leak)', async () => {
    const driver = new LocalDriver(rootDir)
    const sibling = join(parentDir, 'secrets.env')
    writeFileSync(sibling, 'KEY=secret')

    // The file DOES exist on disk but is out-of-root — must NOT leak that.
    await expect(driver.exists('../secrets.env')).resolves.toBe(false)
  })

  it('absolute paths outside the root are also rejected', async () => {
    const driver = new LocalDriver(rootDir)
    // `path.resolve` would normally treat this as absolute and bypass `join`.
    await expect(driver.put('/etc/passwd-attempt', 'pwned')).rejects.toThrow(/E_PATH_TRAVERSAL/)
  })

  it('nested ../ chains still rejected', async () => {
    const driver = new LocalDriver(rootDir)
    await expect(driver.put('foo/../../../etc/passwd-attempt', 'pwned')).rejects.toThrow(
      /E_PATH_TRAVERSAL/,
    )
  })

  it('legitimate in-root nested writes still work', async () => {
    const driver = new LocalDriver(rootDir)
    await driver.put('uploads/avatar.png', 'PNG')
    await expect(driver.exists('uploads/avatar.png')).resolves.toBe(true)
    await expect(driver.get('uploads/avatar.png')).resolves.toBeInstanceOf(Buffer)
  })

  it('symlink under root pointing outside root is rejected on get/put/delete', async () => {
    const { symlinkSync, writeFileSync } = await import('node:fs')
    const driver = new LocalDriver(rootDir)
    // Plant a symlink inside the root pointing at a sibling file
    // OUTSIDE the root — the lexical check passes (link is under
    // root) but realpath catches the escape.
    const outside = join(parentDir, 'outside-secret.env')
    writeFileSync(outside, 'KEY=should-never-leak')
    symlinkSync(outside, join(rootDir, 'leak.env'))

    await expect(driver.get('leak.env')).rejects.toThrow(/E_PATH_TRAVERSAL/)
    await expect(driver.put('leak.env', 'overwrite-attempt')).rejects.toThrow(/E_PATH_TRAVERSAL/)
    await expect(driver.delete('leak.env')).rejects.toThrow(/E_PATH_TRAVERSAL/)
    // Bonus: exists() must NOT confirm a symlink-escape target.
    await expect(driver.exists('leak.env')).resolves.toBe(false)
  })

  it('symlinked subdirectory under root pointing outside is rejected', async () => {
    // Real-world variant: a symlinked DIRECTORY rather than a leaf
    // file. `<root>/uploads → /tmp/elsewhere` then a request for
    // `uploads/notes.txt` resolves to /tmp/elsewhere/notes.txt.
    const { symlinkSync, mkdirSync, writeFileSync } = await import('node:fs')
    const driver = new LocalDriver(rootDir)
    const elsewhere = join(parentDir, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, 'notes.txt'), 'OFF_LIMITS')
    symlinkSync(elsewhere, join(rootDir, 'uploads'))

    await expect(driver.get('uploads/notes.txt')).rejects.toThrow(/E_PATH_TRAVERSAL/)
  })

  it('symlinked ROOT (deploy pattern: current → release-N) still works', async () => {
    // The root itself being a symlink is legitimate. Deploy systems
    // use this pattern to atomically swap releases. The realpath
    // check must canonicalize the root once and not flag access via
    // the symlink as an escape.
    const { mkdtempSync, symlinkSync, rmSync } = await import('node:fs')
    const real = mkdtempSync(join(tmpdir(), 'ream-storage-real-'))
    const sym = join(parentDir, 'current')
    try {
      symlinkSync(real, sym)
      const driver = new LocalDriver(sym)
      await driver.put('hello.txt', 'world')
      await expect(driver.exists('hello.txt')).resolves.toBe(true)
      const body = await driver.get('hello.txt')
      expect(body?.toString()).toBe('world')
    } finally {
      rmSync(real, { recursive: true, force: true })
      try {
        rmSync(sym, { force: true })
      } catch {
        /* link cleanup may race */
      }
    }
  })
})
