/**
 * What the codemods and the `make:*` generators write: a created `.env` is
 * readable by its owner only, and no write goes through a link that leads out
 * of the project — including a link whose target does not exist yet, which
 * `existsSync` reads as "no file" and a write would create.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCodemods } from '../../src/Codemods.js'
import { flush, plannedFile } from '../../src/console/make/flush.js'

let base: string
let project: string

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'codemods-safety-'))
  project = path.join(base, 'project')
  fs.mkdirSync(project)
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

function modeOf(file: string): number {
  return fs.statSync(file).mode & 0o777
}

describe('codemods > addEnvVars file mode', () => {
  it('creates .env owner-only, whatever the umask', async () => {
    const previous = process.umask(0o022)
    try {
      await createCodemods({ cwd: project }).addEnvVars({ JWT_SECRET: 'f'.repeat(64) })
    } finally {
      process.umask(previous)
    }
    expect(modeOf(path.join(project, '.env'))).toBe(0o600)
  })

  it('keeps the mode of an existing .env', async () => {
    const env = path.join(project, '.env')
    fs.writeFileSync(env, 'A=1\n')
    fs.chmodSync(env, 0o640)

    await createCodemods({ cwd: project }).addEnvVars({ B: '2' })

    expect(modeOf(env)).toBe(0o640)
    expect(fs.readFileSync(env, 'utf8')).toBe('A=1\nB=2\n')
  })
})

describe('codemods > links that lead nowhere or outside', () => {
  it('refuses a .env linked to a path that does not exist, and creates nothing', async () => {
    const planted = path.join(base, 'home', 'environment.d', '99-planted.conf')
    fs.mkdirSync(path.dirname(planted), { recursive: true })
    fs.symlinkSync(planted, path.join(project, '.env'))

    await expect(
      createCodemods({ cwd: project }).addEnvVars({ JWT_SECRET: 'f'.repeat(64) }),
    ).rejects.toMatchObject({
      code: 'E_CODEMODS_UNSAFE_PATH',
      message: expect.stringContaining(
        '.env — it is a symbolic link to a path that does not exist',
      ),
    })
    expect(fs.existsSync(planted)).toBe(false)
  })

  it('refuses writeFile through a dangling link', async () => {
    fs.mkdirSync(path.join(project, 'config'))
    const planted = path.join(base, 'planted.ts')
    fs.symlinkSync(planted, path.join(project, 'config', 'auth.ts'))

    await expect(
      createCodemods({ cwd: project }).writeFile('config/auth.ts', 'export default {}\n'),
    ).rejects.toMatchObject({ code: 'E_CODEMODS_UNSAFE_PATH' })
    expect(fs.existsSync(planted)).toBe(false)
  })

  it('refuses writeFile into a directory linked outside the project', async () => {
    const outside = path.join(base, 'outside')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(project, 'config'))

    await expect(
      createCodemods({ cwd: project }).writeFile('config/nested/auth.ts', 'x\n'),
    ).rejects.toMatchObject({
      code: 'E_CODEMODS_UNSAFE_PATH',
      message: expect.stringContaining('its directory resolves outside the project root'),
    })
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('still writes through a link that stays inside the project', async () => {
    fs.mkdirSync(path.join(project, 'shared'))
    fs.writeFileSync(path.join(project, 'shared', 'auth.ts'), 'old\n')
    fs.mkdirSync(path.join(project, 'config'))
    fs.symlinkSync(path.join(project, 'shared', 'auth.ts'), path.join(project, 'config', 'auth.ts'))

    await createCodemods({ cwd: project }).writeFile('config/auth.ts', 'new\n', { force: true })

    expect(fs.readFileSync(path.join(project, 'shared', 'auth.ts'), 'utf8')).toBe('new\n')
  })

  it('creates a new file through writeFile', async () => {
    await createCodemods({ cwd: project }).writeFile('config/new.ts', 'x\n')
    expect(fs.readFileSync(path.join(project, 'config', 'new.ts'), 'utf8')).toBe('x\n')
  })
})

describe('make > flush through a link', () => {
  const destination = 'app/controllers/users_controller.ts'

  function plantDanglingLink(): string {
    fs.mkdirSync(path.join(project, 'app', 'controllers'), { recursive: true })
    const planted = path.join(base, 'planted-by-make.ts')
    fs.symlinkSync(planted, path.join(project, destination))
    return planted
  }

  it('counts a dangling link as something there, and skips it without --force', () => {
    const planted = plantDanglingLink()
    const entry = plannedFile(destination, 'export default class UsersController {}\n', project)
    expect(entry.exists).toBe(true)

    const outcome = flush([entry], [], { cwd: project, dryRun: false, force: false })

    expect(outcome).toMatchObject({ status: 'written', skippedFiles: [destination] })
    expect(fs.existsSync(planted)).toBe(false)
  })

  it('refuses it with --force', () => {
    const planted = plantDanglingLink()
    const entry = plannedFile(destination, 'export default class UsersController {}\n', project)

    expect(() => flush([entry], [], { cwd: project, dryRun: false, force: true })).toThrow(
      expect.objectContaining({ code: 'E_REAM_STUB_UNSAFE_PATH' }),
    )
    expect(fs.existsSync(planted)).toBe(false)
  })

  it('refuses a destination linked to an existing file outside the project', () => {
    fs.mkdirSync(path.join(project, 'app', 'controllers'), { recursive: true })
    const outside = path.join(base, 'outside.ts')
    fs.writeFileSync(outside, 'kept\n')
    fs.symlinkSync(outside, path.join(project, destination))
    const entry = plannedFile(destination, 'overwritten\n', project)

    expect(() => flush([entry], [], { cwd: project, dryRun: false, force: true })).toThrow(
      expect.objectContaining({ code: 'E_REAM_STUB_UNSAFE_PATH' }),
    )
    expect(fs.readFileSync(outside, 'utf8')).toBe('kept\n')
  })
})
