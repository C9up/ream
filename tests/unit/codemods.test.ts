import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCodemods } from '../../src/Codemods.js'
import { bypassTypeCheck } from '../__helpers__/bypass-type-check.js'

describe('Codemods', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemods-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('writeFile', () => {
    it('writes a file inside project root', async () => {
      const codemods = createCodemods({ cwd: tmpDir })
      await codemods.writeFile('config/test.ts', 'export default {}')
      expect(fs.readFileSync(path.join(tmpDir, 'config/test.ts'), 'utf8')).toBe('export default {}')
    })

    it('rejects absolute paths', async () => {
      const codemods = createCodemods({ cwd: tmpDir })
      await expect(codemods.writeFile('/etc/passwd', 'hacked')).rejects.toThrow(
        'Absolute paths not allowed',
      )
    })

    it('rejects path traversal with ..', async () => {
      const codemods = createCodemods({ cwd: tmpDir })
      await expect(codemods.writeFile('../outside.txt', 'hacked')).rejects.toThrow(
        'outside project root',
      )
    })

    it('does not overwrite without force', async () => {
      const codemods = createCodemods({ cwd: tmpDir })
      const file = path.join(tmpDir, 'existing.ts')
      fs.writeFileSync(file, 'original')
      await codemods.writeFile('existing.ts', 'new content')
      expect(fs.readFileSync(file, 'utf8')).toBe('original')
    })

    it('overwrites with force', async () => {
      const codemods = createCodemods({ cwd: tmpDir, force: true })
      const file = path.join(tmpDir, 'existing.ts')
      fs.writeFileSync(file, 'original')
      await codemods.writeFile('existing.ts', 'new content')
      expect(fs.readFileSync(file, 'utf8')).toBe('new content')
    })
  })

  describe('addProvider', () => {
    it('adds a provider to reamrc.ts', async () => {
      const rcPath = path.join(tmpDir, 'reamrc.ts')
      fs.writeFileSync(rcPath, `export default {\n  providers: [\n  ],\n}`)
      const codemods = createCodemods({ cwd: tmpDir })
      await codemods.addProvider('@c9up/atlas/provider')
      const content = fs.readFileSync(rcPath, 'utf8')
      expect(content).toContain("import('@c9up/atlas/provider')")
    })

    it('does not duplicate an existing provider', async () => {
      const rcPath = path.join(tmpDir, 'reamrc.ts')
      fs.writeFileSync(
        rcPath,
        `export default {\n  providers: [\n    () => import('@c9up/atlas/provider'),\n  ],\n}`,
      )
      const codemods = createCodemods({ cwd: tmpDir })
      await codemods.addProvider('@c9up/atlas/provider')
      const content = fs.readFileSync(rcPath, 'utf8')
      const matches = content.match(/@c9up\/atlas\/provider/g)
      expect(matches).toHaveLength(1)
    })

    it('throws when reamrc.ts is missing', async () => {
      const codemods = createCodemods({ cwd: tmpDir })
      await expect(codemods.addProvider('@c9up/atlas/provider')).rejects.toThrow(
        'reamrc.ts not found',
      )
    })

    it('refuses to follow a symlinked reamrc.ts pointing outside project root', async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemods-outside-prov-'))
      try {
        const realRcPath = path.join(outsideDir, 'reamrc.ts')
        fs.writeFileSync(realRcPath, `export default {\n  providers: [\n  ],\n}`)
        fs.symlinkSync(realRcPath, path.join(tmpDir, 'reamrc.ts'))

        const codemods = createCodemods({ cwd: tmpDir })
        await expect(codemods.addProvider('@c9up/atlas/provider')).rejects.toThrow(
          /Symlink escape detected: reamrc\.ts/,
        )
        // The outside file must be untouched.
        expect(fs.readFileSync(realRcPath, 'utf8')).toBe(
          `export default {\n  providers: [\n  ],\n}`,
        )
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true })
      }
    })

    it('throws when providers pattern not found in reamrc.ts', async () => {
      const rcPath = path.join(tmpDir, 'reamrc.ts')
      fs.writeFileSync(rcPath, `export default { modules: [] }`)
      const codemods = createCodemods({ cwd: tmpDir })
      await expect(codemods.addProvider('@c9up/atlas/provider')).rejects.toThrow('Could not find')
    })

    it('preserves CRLF line endings on Windows-checkout reamrc.ts', async () => {
      const rcPath = path.join(tmpDir, 'reamrc.ts')
      fs.writeFileSync(
        rcPath,
        `import { defineConfig } from '@c9up/ream'\r\n\r\nexport default defineConfig({\r\n  providers: [\r\n  ],\r\n})\r\n`,
      )
      const codemods = createCodemods({ cwd: tmpDir })
      await codemods.addProvider('@c9up/test-provider')
      const content = fs.readFileSync(rcPath, 'utf8')
      expect(content).toContain("import('@c9up/test-provider')")
      expect(content).toContain('\r\n')
      const lfOnlyHits = content.match(/(?<!\r)\n/g) ?? []
      expect(lfOnlyHits).toHaveLength(0)
    })

    it('preserves LF line endings on Linux/macOS reamrc.ts', async () => {
      const rcPath = path.join(tmpDir, 'reamrc.ts')
      fs.writeFileSync(
        rcPath,
        `import { defineConfig } from '@c9up/ream'\n\nexport default defineConfig({\n  providers: [\n  ],\n})\n`,
      )
      const codemods = createCodemods({ cwd: tmpDir })
      await codemods.addProvider('@c9up/test-provider')
      const content = fs.readFileSync(rcPath, 'utf8')
      expect(content).toContain("import('@c9up/test-provider')")
      expect(content).not.toContain('\r\n')
    })
  })

  describe('addEnvVars', () => {
    it('creates .env if missing', async () => {
      const codemods = createCodemods({ cwd: tmpDir })
      await codemods.addEnvVars({ DB_HOST: 'localhost', DB_PORT: '5432' })
      const content = fs.readFileSync(path.join(tmpDir, '.env'), 'utf8')
      expect(content).toContain('DB_HOST=localhost')
      expect(content).toContain('DB_PORT=5432')
    })

    it('does not duplicate existing vars', async () => {
      const envPath = path.join(tmpDir, '.env')
      fs.writeFileSync(envPath, 'DB_HOST=existing\n')
      const codemods = createCodemods({ cwd: tmpDir })
      await codemods.addEnvVars({ DB_HOST: 'new', DB_PORT: '5432' })
      const content = fs.readFileSync(envPath, 'utf8')
      expect(content.match(/DB_HOST=/g)).toHaveLength(1)
      expect(content).toContain('DB_PORT=5432')
    })

    it('refuses to follow a symlinked .env pointing outside project root', async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemods-outside-env-'))
      try {
        const realEnvPath = path.join(outsideDir, '.env')
        fs.writeFileSync(realEnvPath, 'EXISTING=1\n')
        fs.symlinkSync(realEnvPath, path.join(tmpDir, '.env'))

        const codemods = createCodemods({ cwd: tmpDir })
        await expect(codemods.addEnvVars({ SECRET: 'leaked' })).rejects.toThrow(
          /Symlink escape detected: \.env/,
        )
        // The outside file must be untouched.
        expect(fs.readFileSync(realEnvPath, 'utf8')).toBe('EXISTING=1\n')
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true })
      }
    })
  })

  describe('registerCommand', () => {
    it('inserts a command into an existing commands: [] array', async () => {
      const rcPath = path.join(tmpDir, 'reamrc.ts')
      fs.writeFileSync(
        rcPath,
        `import { defineConfig } from '@c9up/ream'\n\nexport default defineConfig({\n  providers: [\n  ],\n  commands: [\n  ],\n})\n`,
      )
      const codemods = createCodemods({ cwd: tmpDir })
      await codemods.registerCommand('@community/postmark/commands/send-test.js')
      const content = fs.readFileSync(rcPath, 'utf8')
      expect(content).toContain("() => import('@community/postmark/commands/send-test.js'),")
      const arrayMatch = content.match(/commands\s*:\s*\[([\s\S]*?)\]/)
      expect(arrayMatch?.[1]).toContain('@community/postmark/commands/send-test.js')
    })

    it('is idempotent on re-run', async () => {
      const rcPath = path.join(tmpDir, 'reamrc.ts')
      fs.writeFileSync(
        rcPath,
        `import { defineConfig } from '@c9up/ream'\n\nexport default defineConfig({\n  providers: [],\n  commands: [],\n})\n`,
      )
      const codemods = createCodemods({ cwd: tmpDir })
      await codemods.registerCommand('@community/echo/cmd.js')
      await codemods.registerCommand('@community/echo/cmd.js')
      const content = fs.readFileSync(rcPath, 'utf8')
      const matches = content.match(/@community\/echo\/cmd\.js/g)
      expect(matches).toHaveLength(1)
    })

    it('bootstraps commands: [] after providers when absent', async () => {
      const rcPath = path.join(tmpDir, 'reamrc.ts')
      fs.writeFileSync(
        rcPath,
        `import { defineConfig } from '@c9up/ream'\n\nexport default defineConfig({\n  providers: [\n    () => import('@c9up/atlas/provider'),\n  ],\n})\n`,
      )
      const codemods = createCodemods({ cwd: tmpDir })
      await codemods.registerCommand('@community/echo/cmd.js')
      const content = fs.readFileSync(rcPath, 'utf8')
      expect(content).toMatch(/commands\s*:\s*\[/)
      expect(content).toContain("() => import('@community/echo/cmd.js'),")
      const providersIdx = content.indexOf('providers')
      const commandsIdx = content.indexOf('commands')
      expect(commandsIdx).toBeGreaterThan(providersIdx)
    })

    it('bootstraps commands: [] before defineConfig closing when no providers field', async () => {
      const rcPath = path.join(tmpDir, 'reamrc.ts')
      fs.writeFileSync(
        rcPath,
        `import { defineConfig } from '@c9up/ream'\n\nexport default defineConfig({\n  modules: { path: './app/modules' },\n})\n`,
      )
      const codemods = createCodemods({ cwd: tmpDir })
      await codemods.registerCommand('@community/echo/cmd.js')
      const content = fs.readFileSync(rcPath, 'utf8')
      expect(content).toMatch(/commands\s*:\s*\[/)
      expect(content).toContain("() => import('@community/echo/cmd.js'),")
      expect(content.trim().endsWith('})')).toBe(true)
    })

    it('throws when reamrc.ts is missing', async () => {
      const codemods = createCodemods({ cwd: tmpDir })
      await expect(codemods.registerCommand('@community/echo/cmd.js')).rejects.toThrow(
        '[configure] reamrc.ts not found',
      )
    })

    it('throws when neither commands, providers, nor defineConfig({}) markers exist', async () => {
      const rcPath = path.join(tmpDir, 'reamrc.ts')
      fs.writeFileSync(rcPath, `// totally non-canonical\nexport const x = 1\n`)
      const codemods = createCodemods({ cwd: tmpDir })
      await expect(codemods.registerCommand('@community/echo/cmd.js')).rejects.toThrow(
        "[configure] Could not find 'defineConfig({ ... })' in reamrc.ts",
      )
    })

    it('targets the LAST }) in the file when bootstrapping (not a helper above defineConfig) [F3]', async () => {
      const rcPath = path.join(tmpDir, 'reamrc.ts')
      fs.writeFileSync(
        rcPath,
        `import { defineConfig } from '@c9up/ream'\n\nconst helperOptions = makeOptions({ eager: true })\n\nexport default defineConfig({\n  modules: { path: './app/modules' },\n})\n`,
      )
      const codemods = createCodemods({ cwd: tmpDir })
      await codemods.registerCommand('@community/echo/cmd.js')
      const content = fs.readFileSync(rcPath, 'utf8')
      expect(content).toContain("() => import('@community/echo/cmd.js'),")
      const helperIdx = content.indexOf('const helperOptions')
      const commandsIdx = content.indexOf('commands:')
      expect(commandsIdx).toBeGreaterThan(helperIdx)
      expect(content).toMatch(/export default defineConfig\([\s\S]*commands\s*:[\s\S]*\}\)\s*$/)
    })

    it('rejects a nested `commands:` higher in the file (e.g. tests: { commands: [...] }) [F4]', async () => {
      const rcPath = path.join(tmpDir, 'reamrc.ts')
      fs.writeFileSync(
        rcPath,
        `import { defineConfig } from '@c9up/ream'\n\nexport default defineConfig({\n  providers: [],\n  tests: {\n    suites: [\n      { name: 'unit', commands: ['vitest run'] },\n    ],\n  },\n})\n`,
      )
      const codemods = createCodemods({ cwd: tmpDir })
      await codemods.registerCommand('@community/echo/cmd.js')
      const content = fs.readFileSync(rcPath, 'utf8')
      expect(content).toContain("() => import('@community/echo/cmd.js'),")
      const topLevelMatch = content.match(/^[ \t]{0,4}commands\s*:\s*\[/m)
      expect(topLevelMatch).not.toBeNull()
      const nestedTestsMatch = content.match(
        /suites:\s*\[\s*\{\s*name:\s*'unit',\s*commands:\s*\['vitest run'\]/,
      )
      expect(nestedTestsMatch).not.toBeNull()
    })

    it('preserves CRLF line endings when bootstrapping [F7]', async () => {
      const rcPath = path.join(tmpDir, 'reamrc.ts')
      fs.writeFileSync(
        rcPath,
        `import { defineConfig } from '@c9up/ream'\r\n\r\nexport default defineConfig({\r\n  providers: [],\r\n})\r\n`,
      )
      const codemods = createCodemods({ cwd: tmpDir })
      await codemods.registerCommand('@community/echo/cmd.js')
      const content = fs.readFileSync(rcPath, 'utf8')
      expect(content).toContain('\r\n')
      const lfOnlyHits = content.match(/(?<!\r)\n/g) ?? []
      expect(lfOnlyHits).toHaveLength(0)
    })

    it('refuses to follow a symlinked reamrc.ts pointing outside project root', async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemods-outside-'))
      try {
        const realRcPath = path.join(outsideDir, 'reamrc.ts')
        fs.writeFileSync(realRcPath, 'export default { providers: [], commands: [] }')
        fs.symlinkSync(realRcPath, path.join(tmpDir, 'reamrc.ts'))

        const codemods = createCodemods({ cwd: tmpDir })
        await expect(codemods.registerCommand('@plugin/cmd.js')).rejects.toThrow(
          /Symlink escape detected: reamrc\.ts/,
        )

        expect(fs.readFileSync(realRcPath, 'utf8')).toBe(
          'export default { providers: [], commands: [] }',
        )
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true })
      }
    })
  })

  describe('registerMiddleware', () => {
    function writeKernel(kernelDir: string, body: string): string {
      const dir = path.join(kernelDir, 'start')
      fs.mkdirSync(dir, { recursive: true })
      const kernelPath = path.join(dir, 'kernel.ts')
      fs.writeFileSync(kernelPath, body)
      return kernelPath
    }

    const canonicalKernel = `import router from '@c9up/ream/services/router'\nimport server from '@c9up/ream/services/server'\n\nserver.use([\n])\n\nrouter.use([\n])\n\nexport const middleware = router.named({})\n`

    it('inserts into router.use([ ]) by default', async () => {
      const kernelPath = writeKernel(tmpDir, canonicalKernel)
      const codemods = createCodemods({ cwd: tmpDir })
      await codemods.registerMiddleware('@community/csrf/middleware.js')
      const content = fs.readFileSync(kernelPath, 'utf8')
      const routerBlock = content.match(/router\.use\(\[([\s\S]*?)\]\)/)
      expect(routerBlock?.[1]).toContain("() => import('@community/csrf/middleware.js'),")
      const serverBlock = content.match(/server\.use\(\[([\s\S]*?)\]\)/)
      expect(serverBlock?.[1]).not.toContain('@community/csrf/middleware.js')
    })

    it("inserts into server.use([ ]) when tier='server'", async () => {
      const kernelPath = writeKernel(tmpDir, canonicalKernel)
      const codemods = createCodemods({ cwd: tmpDir })
      await codemods.registerMiddleware('@community/headers/middleware.js', {
        tier: 'server',
      })
      const content = fs.readFileSync(kernelPath, 'utf8')
      const serverBlock = content.match(/server\.use\(\[([\s\S]*?)\]\)/)
      expect(serverBlock?.[1]).toContain("() => import('@community/headers/middleware.js'),")
      const routerBlock = content.match(/router\.use\(\[([\s\S]*?)\]\)/)
      expect(routerBlock?.[1]).not.toContain('@community/headers/middleware.js')
    })

    it('is idempotent per-tier on re-run', async () => {
      const kernelPath = writeKernel(tmpDir, canonicalKernel)
      const codemods = createCodemods({ cwd: tmpDir })
      await codemods.registerMiddleware('@community/csrf/middleware.js')
      await codemods.registerMiddleware('@community/csrf/middleware.js')
      const content = fs.readFileSync(kernelPath, 'utf8')
      const matches = content.match(/@community\/csrf\/middleware\.js/g)
      expect(matches).toHaveLength(1)
    })

    it('throws when start/kernel.ts is missing', async () => {
      const codemods = createCodemods({ cwd: tmpDir })
      await expect(codemods.registerMiddleware('@community/csrf/middleware.js')).rejects.toThrow(
        '[configure] start/kernel.ts not found',
      )
    })

    it('throws when target tier block is absent (no bootstrap)', async () => {
      writeKernel(tmpDir, `import server from '@c9up/ream/services/server'\n\nserver.use([\n])\n`)
      const codemods = createCodemods({ cwd: tmpDir })
      await expect(
        codemods.registerMiddleware('@community/csrf/middleware.js', { tier: 'router' }),
      ).rejects.toThrow("[configure] Could not find 'router.use([' in start/kernel.ts")
    })

    it('rejects an invalid tier', async () => {
      writeKernel(tmpDir, canonicalKernel)
      const codemods = createCodemods({ cwd: tmpDir })
      // Use bypassTypeCheck<T> for runtime-bad-value injection — see helper JSDoc.
      const opts = bypassTypeCheck<{ tier?: 'server' | 'router' }>({ tier: 'global' })
      await expect(codemods.registerMiddleware('@community/x/middleware.js', opts)).rejects.toThrow(
        "[configure] Invalid middleware tier: 'global'. Expected 'server' or 'router'.",
      )
    })

    it('rejects cross-tier collision when same import is already in the other tier', async () => {
      const kernelPath = writeKernel(tmpDir, canonicalKernel)
      const codemods = createCodemods({ cwd: tmpDir })
      await codemods.registerMiddleware('@community/m/middleware.js', { tier: 'router' })
      await expect(
        codemods.registerMiddleware('@community/m/middleware.js', { tier: 'server' }),
      ).rejects.toThrow(
        '[configure] middleware @community/m/middleware.js is already registered in router tier — cannot also register in server tier.',
      )
      const content = fs.readFileSync(kernelPath, 'utf8')
      const matches = content.match(/@community\/m\/middleware\.js/g)
      expect(matches).toHaveLength(1)
    })

    it('tolerates whitespace and a leading comment between use( and the array literal', async () => {
      const kernelPath = writeKernel(
        tmpDir,
        `import router from '@c9up/ream/services/router'\nimport server from '@c9up/ream/services/server'\n\nserver.use([])\n\nrouter.use(\n  /* canonical block */\n  [\n  ],\n)\n`,
      )
      const codemods = createCodemods({ cwd: tmpDir })
      await codemods.registerMiddleware('@community/x/middleware.js')
      const content = fs.readFileSync(kernelPath, 'utf8')
      expect(content).toContain("() => import('@community/x/middleware.js'),")
    })

    it('tolerates a non-empty array body with nested ] for the dedup window [F1]', async () => {
      // Realistic kernel where `router.use([...])` already contains an entry whose
      // signature happens to include a `]` (e.g. a type-arg in the import path string is
      // exotic but not impossible; here we use a plain entry plus a comment containing `]`
      // to exercise the dedup window).
      const kernelPath = writeKernel(
        tmpDir,
        `import router from '@c9up/ream/services/router'\nimport server from '@c9up/ream/services/server'\n\nserver.use([])\n\nrouter.use([\n  () => import('@community/existing/middleware.js'), // tracked as ['existing']\n])\n`,
      )
      const codemods = createCodemods({ cwd: tmpDir })
      await codemods.registerMiddleware('@community/existing/middleware.js')
      const content = fs.readFileSync(kernelPath, 'utf8')
      const matches = content.match(/@community\/existing\/middleware\.js/g) ?? []
      expect(matches.length).toBeLessThanOrEqual(2)
      const importMatches =
        content.match(/() => import\('@community\/existing\/middleware\.js'\)/g) ?? []
      expect(importMatches).toHaveLength(1)
    })

    it('rejects a `customServer.use([...])` neighbor when scanning for tier server [F5]', async () => {
      // A user with an Express-style adapter wrapping a third-party `customServer` next to
      // the canonical `server`. Without word-boundary anchoring, `findTierBlock('server')`
      // would match `customServer.use([` first and operate on the wrong block.
      const kernelPath = writeKernel(
        tmpDir,
        `import router from '@c9up/ream/services/router'\nimport server from '@c9up/ream/services/server'\nimport customServer from './customServer.js'\n\ncustomServer.use([\n])\n\nserver.use([\n])\n\nrouter.use([\n])\n`,
      )
      const codemods = createCodemods({ cwd: tmpDir })
      await codemods.registerMiddleware('@community/headers/middleware.js', { tier: 'server' })
      const content = fs.readFileSync(kernelPath, 'utf8')
      const customServerBlock = content.match(/customServer\.use\(\[([\s\S]*?)\]\)/)
      expect(customServerBlock?.[1]).not.toContain('@community/headers/middleware.js')
      const serverBlock = content.match(/(?:^|[^A-Za-z0-9_$.])server\.use\(\[([\s\S]*?)\]\)/m)
      expect(serverBlock?.[1]).toContain("() => import('@community/headers/middleware.js'),")
    })

    it('preserves CRLF line endings when inserting [F7]', async () => {
      const kernelPath = writeKernel(
        tmpDir,
        `import router from '@c9up/ream/services/router'\r\nimport server from '@c9up/ream/services/server'\r\n\r\nserver.use([\r\n])\r\n\r\nrouter.use([\r\n])\r\n`,
      )
      const codemods = createCodemods({ cwd: tmpDir })
      await codemods.registerMiddleware('@community/csrf/middleware.js')
      const content = fs.readFileSync(kernelPath, 'utf8')
      expect(content).toContain('\r\n')
      const lfOnlyHits = content.match(/(?<!\r)\n/g) ?? []
      expect(lfOnlyHits).toHaveLength(0)
    })

    it('refuses to follow a symlinked start/kernel.ts pointing outside project root', async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemods-outside-'))
      try {
        const realKernelPath = path.join(outsideDir, 'kernel.ts')
        fs.writeFileSync(
          realKernelPath,
          `import router from '@c9up/ream/services/router'\nimport server from '@c9up/ream/services/server'\n\nserver.use([\n])\n\nrouter.use([\n])\n`,
        )
        const startDir = path.join(tmpDir, 'start')
        fs.mkdirSync(startDir, { recursive: true })
        fs.symlinkSync(realKernelPath, path.join(startDir, 'kernel.ts'))

        const codemods = createCodemods({ cwd: tmpDir })
        await expect(codemods.registerMiddleware('@plugin/mw.js')).rejects.toThrow(
          /Symlink escape detected: start\/kernel\.ts/,
        )

        const original = fs.readFileSync(realKernelPath, 'utf8')
        expect(original).not.toContain('@plugin/mw.js')
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true })
      }
    })
  })
})
