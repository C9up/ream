import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCodemods } from '../../src/Codemods.js'
import { configure } from '../fixtures/configure-register-sample/src/configure.js'

/**
 * Roundtrip integration: a sample plugin's `configure()` hook drives the live
 * `createCodemods()` against a hermetic tmp project. Exercises the public
 * Codemods surface (`registerCommand` + `registerMiddleware`) end-to-end —
 * NOT the `ream add` Rust dispatch path (cargo integration tests cover that).
 */
describe('configure() roundtrip — registerCommand + registerMiddleware', () => {
  let tmpDir: string

  const reamrcSeed = `import { defineConfig } from '@c9up/ream'

export default defineConfig({
  providers: [
    () => import('@c9up/atlas/provider'),
  ],
})
`

  const kernelSeed = `import router from '@c9up/ream/services/router'
import server from '@c9up/ream/services/server'

server.use([
])

router.use([
])

export const middleware = router.named({})
`

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'configure-register-sample-'))
    fs.writeFileSync(path.join(tmpDir, 'reamrc.ts'), reamrcSeed)
    const startDir = path.join(tmpDir, 'start')
    fs.mkdirSync(startDir, { recursive: true })
    fs.writeFileSync(path.join(startDir, 'kernel.ts'), kernelSeed)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('inserts the command import into reamrc.ts and the middleware import into start/kernel.ts', async () => {
    const codemods = createCodemods({ cwd: tmpDir })
    await configure(codemods)

    const rcContent = fs.readFileSync(path.join(tmpDir, 'reamrc.ts'), 'utf8')
    expect(rcContent).toMatch(/commands\s*:\s*\[/)
    expect(rcContent).toContain("() => import('@test-fixture/register-sample/commands/echo'),")

    const kernelContent = fs.readFileSync(path.join(tmpDir, 'start', 'kernel.ts'), 'utf8')
    const routerBlock = kernelContent.match(/router\.use\(\[([\s\S]*?)\]\)/)
    expect(routerBlock?.[1]).toContain(
      "() => import('@test-fixture/register-sample/middleware/sample'),",
    )
    const serverBlock = kernelContent.match(/server\.use\(\[([\s\S]*?)\]\)/)
    expect(serverBlock?.[1]).not.toContain('@test-fixture/register-sample/middleware/sample')
  })

  it('is idempotent — re-running configure() produces the same single entries', async () => {
    const codemods = createCodemods({ cwd: tmpDir })
    await configure(codemods)
    await configure(codemods)

    const rcContent = fs.readFileSync(path.join(tmpDir, 'reamrc.ts'), 'utf8')
    const cmdMatches = rcContent.match(/@test-fixture\/register-sample\/commands\/echo/g)
    expect(cmdMatches).toHaveLength(1)

    const kernelContent = fs.readFileSync(path.join(tmpDir, 'start', 'kernel.ts'), 'utf8')
    const mwMatches = kernelContent.match(/@test-fixture\/register-sample\/middleware\/sample/g)
    expect(mwMatches).toHaveLength(1)
  })
})
