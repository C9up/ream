import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fsImportAll, fsReadAll } from '../../src/helpers/fs.js'

let base: string
let root: string

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'ream-fs-'))
  // A space and a non-ASCII letter: both are percent-encoded in a URL's pathname.
  root = join(base, 'my app café', 'config')
  await mkdir(join(root, 'database'), { recursive: true })
  await mkdir(join(root, '.old'), { recursive: true })
  await writeFile(join(root, 'app.js'), 'export default { a: 1 }\n')
  await writeFile(join(root, 'database', 'pg.js'), 'export const pg = 1\n')
  await writeFile(join(root, 'mail.json'), '{ "from": "x@y.z" }\n')
  await writeFile(join(root, 'README.md'), '# not a module\n')
  await writeFile(join(root, '.backup.js'), 'globalThis.REAM_FS_RAN_DOT_FILE = true\n')
  await writeFile(join(root, '.old', 'leak.js'), 'globalThis.REAM_FS_RAN_HIDDEN = true\n')
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('fsReadAll', () => {
  it('reads the directory a file URL names, whatever its path contains', async () => {
    const files = await fsReadAll(pathToFileURL(`${root}/`))
    expect(files).toEqual(['app.js', 'database/pg.js', 'mail.json', 'README.md'])
  })

  it('does not turn a URL into a silent empty result under ignoreMissingRoot', async () => {
    const files = await fsReadAll(pathToFileURL(`${root}/`), { ignoreMissingRoot: true })
    expect(files).toHaveLength(4)
  })

  it('still returns [] for a missing root under ignoreMissingRoot, and throws without it', async () => {
    const missing = pathToFileURL(join(base, 'nope/'))
    expect(await fsReadAll(missing, { ignoreMissingRoot: true })).toEqual([])
    await expect(fsReadAll(missing)).rejects.toThrow()
  })

  it('skips dot-files and files under dot-directories', async () => {
    const files = await fsReadAll(root)
    expect(files.some((file) => file.includes('.old') || file.includes('.backup'))).toBe(false)
  })

  it('formats paths per pathType', async () => {
    expect(await fsReadAll(root, { pathType: 'absolute' })).toContain(
      join(root, 'database', 'pg.js'),
    )
    expect(await fsReadAll(root, { pathType: 'url' })).toContain(
      pathToFileURL(join(root, 'app.js')).href,
    )
  })

  it('sorts naturally by default', async () => {
    const dir = join(base, 'sorted')
    await mkdir(dir, { recursive: true })
    for (const name of ['10.js', '2.js', '1.js']) await writeFile(join(dir, name), '')
    expect(await fsReadAll(dir)).toEqual(['1.js', '2.js', '10.js'])
  })
})

describe('fsImportAll', () => {
  it('nests modules by path segment, imports JSON, and never runs a dot-file', async () => {
    const collection = await fsImportAll(pathToFileURL(`${root}/`))
    expect(collection).toEqual({
      app: { a: 1 },
      database: { pg: { pg: 1 } },
      mail: { from: 'x@y.z' },
    })
    expect(Reflect.get(globalThis, 'REAM_FS_RAN_HIDDEN')).toBeUndefined()
    expect(Reflect.get(globalThis, 'REAM_FS_RAN_DOT_FILE')).toBeUndefined()
  })

  it('hands transformKeys the segment array', async () => {
    const seen: string[][] = []
    const collection = await fsImportAll(root, {
      transformKeys: (keys) => {
        seen.push(keys)
        return keys.map((key) => key.toUpperCase())
      },
    })
    expect(seen).toContainEqual(['database', 'pg'])
    expect(collection).toHaveProperty(['DATABASE', 'PG'])
  })

  it('refuses a key segment that would reach a prototype', async () => {
    const collection = await fsImportAll(root, {
      filter: (file) => file.endsWith('app.js'),
      transformKeys: () => ['__proto__', 'polluted'],
    })
    const empty: Record<string, unknown> = {}
    expect(empty.polluted).toBeUndefined()
    expect(Object.getPrototypeOf(collection)).toBe(Object.prototype)
  })
})
