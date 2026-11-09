/**
 * `addPreloadFile` — a package whose configure hook writes a `start/*.ts`
 * file registers it in `reamrc.ts`, or nothing ever loads it.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCodemods } from '../../src/Codemods.js'

const RC = `import { defineConfig } from '@c9up/ream'

export default defineConfig({
  providers: [
    () => import('@c9up/ream/events/provider'),
  ],
  preloads: [
    () => import('#start/routes.js'),
    () => import('#start/kernel.js'),
  ],
})
`

describe('Codemods > addPreloadFile', () => {
  let root: string
  let rcPath: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codemods-preload-'))
    rcPath = path.join(root, 'reamrc.ts')
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  const read = () => fs.readFileSync(rcPath, 'utf8')

  it('appends the preload after the existing ones', async () => {
    fs.writeFileSync(rcPath, RC)
    await createCodemods({ cwd: root }).addPreloadFile('#start/metrics.js')
    expect(read()).toBe(
      RC.replace(
        "    () => import('#start/kernel.js'),\n",
        "    () => import('#start/kernel.js'),\n    () => import('#start/metrics.js'),\n",
      ),
    )
  })

  it('is idempotent, including for an entry scoped to environments', async () => {
    fs.writeFileSync(rcPath, RC)
    const codemods = createCodemods({ cwd: root })
    await codemods.addPreloadFile('#start/routes.js')
    expect(read()).toBe(RC)
    await codemods.addPreloadFile('#start/metrics.js', ['web'])
    const once = read()
    await codemods.addPreloadFile('#start/metrics.js', ['web'])
    await codemods.addPreloadFile('#start/metrics.js')
    expect(read()).toBe(once)
  })

  it('does not take a provider with the same path for a preload', async () => {
    fs.writeFileSync(rcPath, RC.replace('@c9up/ream/events/provider', '#start/metrics.js'))
    await createCodemods({ cwd: root }).addPreloadFile('#start/metrics.js')
    expect(read()).toContain(
      "    () => import('#start/kernel.js'),\n    () => import('#start/metrics.js'),\n",
    )
  })

  it('writes an environment-scoped entry for a subset of environments', async () => {
    fs.writeFileSync(rcPath, RC)
    await createCodemods({ cwd: root }).addPreloadFile('#start/metrics.js', ['web', 'test'])
    expect(read()).toBe(
      RC.replace(
        "    () => import('#start/kernel.js'),\n",
        "    () => import('#start/kernel.js'),\n    {\n      file: () => import('#start/metrics.js'),\n      environment: ['web', 'test'],\n    },\n",
      ),
    )
  })

  it('writes a plain entry when every environment is listed', async () => {
    fs.writeFileSync(rcPath, RC)
    await createCodemods({ cwd: root }).addPreloadFile('#start/metrics.js', [
      'web',
      'console',
      'test',
      'repl',
    ])
    expect(read()).toContain("    () => import('#start/metrics.js'),\n")
  })

  it('refuses an unknown environment', async () => {
    fs.writeFileSync(rcPath, RC)
    const environments: string[] = ['web', 'prod']
    await expect(
      Reflect.apply(createCodemods({ cwd: root }).addPreloadFile, undefined, [
        '#start/metrics.js',
        environments,
      ]),
    ).rejects.toThrow(/\[configure\].*prod/)
    expect(read()).toBe(RC)
  })

  it('opens a preloads array when the rc file has none', async () => {
    fs.writeFileSync(
      rcPath,
      "import { defineConfig } from '@c9up/ream'\n\nexport default defineConfig({\n  providers: [],\n})\n",
    )
    await createCodemods({ cwd: root }).addPreloadFile('#start/metrics.js')
    expect(read()).toBe(
      "import { defineConfig } from '@c9up/ream'\n\nexport default defineConfig({\n  providers: [],\n  preloads: [\n    () => import('#start/metrics.js'),\n  ],\n})\n",
    )
  })

  it('fills an empty inline preloads array', async () => {
    fs.writeFileSync(
      rcPath,
      'export default defineConfig({\n  providers: [],\n  preloads: [],\n})\n',
    )
    await createCodemods({ cwd: root }).addPreloadFile('#start/metrics.js')
    expect(read()).toBe(
      "export default defineConfig({\n  providers: [],\n  preloads: [\n    () => import('#start/metrics.js'),\n  ],\n})\n",
    )
  })

  it('edits a plain exported object as well as a defineConfig call', async () => {
    fs.writeFileSync(rcPath, 'export default {\n  providers: [\n  ],\n}\n')
    await createCodemods({ cwd: root }).addPreloadFile('#start/metrics.js')
    expect(read()).toBe(
      "export default {\n  providers: [\n  ],\n  preloads: [\n    () => import('#start/metrics.js'),\n  ],\n}\n",
    )
  })

  it('preserves CRLF line endings', async () => {
    fs.writeFileSync(rcPath, RC.replace(/\n/g, '\r\n'))
    await createCodemods({ cwd: root }).addPreloadFile('#start/metrics.js')
    expect(read()).toBe(
      RC.replace(
        "    () => import('#start/kernel.js'),\n",
        "    () => import('#start/kernel.js'),\n    () => import('#start/metrics.js'),\n",
      ).replace(/\n/g, '\r\n'),
    )
  })

  it('refuses a module path that would break out of the import string', async () => {
    fs.writeFileSync(rcPath, RC)
    const codemods = createCodemods({ cwd: root })
    for (const bad of ["x'), evil('", 'x\nimport', 'x\\', '', 'x`']) {
      await expect(codemods.addPreloadFile(bad)).rejects.toThrow(/\[configure\]/)
    }
    expect(read()).toBe(RC)
  })

  it('refuses a preloads value it cannot edit', async () => {
    fs.writeFileSync(
      rcPath,
      'const list = []\nexport default defineConfig({\n  preloads: list,\n})\n',
    )
    await expect(createCodemods({ cwd: root }).addPreloadFile('#start/metrics.js')).rejects.toThrow(
      /\[configure\].*preloads/,
    )
  })

  it('says what is missing when there is no rc file or no config object', async () => {
    const codemods = createCodemods({ cwd: root })
    await expect(codemods.addPreloadFile('#start/metrics.js')).rejects.toThrow(
      /reamrc\.ts not found/,
    )
    fs.writeFileSync(rcPath, 'export const nothing = 1\n')
    await expect(codemods.addPreloadFile('#start/metrics.js')).rejects.toThrow(/defineConfig/)
  })

  it('refuses to follow a symlinked reamrc.ts pointing outside the project root', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codemods-preload-outside-'))
    try {
      const target = path.join(outside, 'reamrc.ts')
      fs.writeFileSync(target, RC)
      fs.symlinkSync(target, rcPath)
      await expect(
        createCodemods({ cwd: root }).addPreloadFile('#start/metrics.js'),
      ).rejects.toThrow(/Symlink escape/)
      expect(fs.readFileSync(target, 'utf8')).toBe(RC)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})
