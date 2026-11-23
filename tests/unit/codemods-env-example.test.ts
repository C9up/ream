/**
 * `addEnvVars` documents a package's variables in `.env.example` too, so a
 * fresh clone learns they exist, and keeps secrets out of the committed file.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCodemods } from '../../src/Codemods.js'

describe('Codemods > addEnvVars and .env.example', () => {
  let root: string
  const read = (name: string) => fs.readFileSync(path.join(root, name), 'utf8')

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codemods-env-example-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('writes the variables to both .env and .env.example', async () => {
    fs.writeFileSync(path.join(root, '.env'), 'APP_NAME=x\n')
    fs.writeFileSync(path.join(root, '.env.example'), 'APP_NAME=\n')
    await createCodemods({ cwd: root }).addEnvVars({ REDIS_HOST: '127.0.0.1', REDIS_PORT: '6379' })
    expect(read('.env')).toBe('APP_NAME=x\nREDIS_HOST=127.0.0.1\nREDIS_PORT=6379\n')
    expect(read('.env.example')).toBe('APP_NAME=\nREDIS_HOST=127.0.0.1\nREDIS_PORT=6379\n')
  })

  it('writes an omitted key empty into .env.example only', async () => {
    fs.writeFileSync(path.join(root, '.env'), '')
    fs.writeFileSync(path.join(root, '.env.example'), '')
    await createCodemods({ cwd: root }).addEnvVars(
      { REDIS_HOST: '127.0.0.1', REDIS_PASSWORD: 'dev-secret' },
      { omitFromExample: ['REDIS_PASSWORD'] },
    )
    expect(read('.env')).toContain('REDIS_PASSWORD=dev-secret')
    expect(read('.env.example')).toContain('REDIS_PASSWORD=\n')
    expect(read('.env.example')).not.toContain('dev-secret')
    expect(read('.env.example')).toContain('REDIS_HOST=127.0.0.1')
  })

  it('does not create a .env.example the project does not have', async () => {
    await createCodemods({ cwd: root }).addEnvVars({ REDIS_HOST: '127.0.0.1' })
    expect(fs.existsSync(path.join(root, '.env.example'))).toBe(false)
  })

  it('keeps a value the user already set, in either file', async () => {
    fs.writeFileSync(path.join(root, '.env'), 'REDIS_HOST=old\n')
    fs.writeFileSync(path.join(root, '.env.example'), 'REDIS_HOST=example\n')
    await createCodemods({ cwd: root }).addEnvVars({ REDIS_HOST: '127.0.0.1' })
    expect(read('.env')).toBe('REDIS_HOST=old\n')
    expect(read('.env.example')).toBe('REDIS_HOST=example\n')
  })

  it('replaces an existing line in place under overwrite or --force', async () => {
    fs.writeFileSync(path.join(root, '.env'), 'A=1\nREDIS_HOST=old\nB=2\n')
    fs.writeFileSync(path.join(root, '.env.example'), 'REDIS_HOST=example\nREDIS_PASSWORD=leak\n')
    await createCodemods({ cwd: root }).addEnvVars(
      { REDIS_HOST: '127.0.0.1', REDIS_PASSWORD: 'dev' },
      { overwrite: true, omitFromExample: ['REDIS_PASSWORD'] },
    )
    expect(read('.env')).toBe('A=1\nREDIS_HOST=127.0.0.1\nB=2\nREDIS_PASSWORD=dev\n')
    expect(read('.env.example')).toBe('REDIS_HOST=127.0.0.1\nREDIS_PASSWORD=\n')

    fs.writeFileSync(path.join(root, '.env'), 'REDIS_HOST=old\r\n')
    await createCodemods({ cwd: root, force: true }).addEnvVars({ REDIS_HOST: 'forced' })
    expect(read('.env')).toBe('REDIS_HOST=forced\r\n')
  })

  it('appends after a file that does not end with a newline', async () => {
    fs.writeFileSync(path.join(root, '.env'), 'APP_NAME=x')
    await createCodemods({ cwd: root }).addEnvVars({ REDIS_HOST: '127.0.0.1' })
    expect(read('.env')).toBe('APP_NAME=x\nREDIS_HOST=127.0.0.1\n')
  })

  it('refuses a value or a key that would inject another line', async () => {
    fs.writeFileSync(path.join(root, '.env'), '')
    const codemods = createCodemods({ cwd: root })
    await expect(codemods.addEnvVars({ A: 'x\nAPP_KEY=attacker' })).rejects.toMatchObject({
      code: 'E_CODEMODS_INVALID_ENV_VARIABLE',
      message: expect.stringMatching(/line break/),
    })
    await expect(codemods.addEnvVars({ A: 'x\rB=y' })).rejects.toMatchObject({
      code: 'E_CODEMODS_INVALID_ENV_VARIABLE',
      message: expect.stringMatching(/line break/),
    })
    await expect(codemods.addEnvVars({ 'A=1\nB': 'x' })).rejects.toMatchObject({
      code: 'E_CODEMODS_INVALID_ENV_VARIABLE',
      message: expect.stringMatching(/not a valid/),
    })
    expect(read('.env')).toBe('')
  })
})
