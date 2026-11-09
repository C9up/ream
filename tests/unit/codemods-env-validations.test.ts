/**
 * `defineEnvValidations` — a package's configure hook adds the rules for the
 * variables it writes to `.env` into the app's `start/env.ts` schema.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCodemods } from '../../src/Codemods.js'

const ENV_FILE = `import { Env } from '@c9up/ream'

export default await Env.create(new URL('../', import.meta.url), {
  APP_NAME: Env.schema.string(),
  PORT: Env.schema.number(),
})
`

const REDIS_BLOCK = `
  /*
  |----------------------------------------------------------
  | Redis connection
  |----------------------------------------------------------
  */
  REDIS_HOST: Env.schema.string({ format: 'host' }),
  REDIS_PORT: Env.schema.number(),
`

const redis = {
  leadingComment: 'Redis connection',
  variables: {
    REDIS_HOST: "Env.schema.string({ format: 'host' })",
    REDIS_PORT: 'Env.schema.number()',
  },
}

describe('Codemods > defineEnvValidations', () => {
  let root: string
  let envPath: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codemods-env-'))
    fs.mkdirSync(path.join(root, 'start'))
    envPath = path.join(root, 'start', 'env.ts')
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  const read = () => fs.readFileSync(envPath, 'utf8')

  it('appends the rules under a leading comment, after the existing ones', async () => {
    fs.writeFileSync(envPath, ENV_FILE)
    const kept = await createCodemods({ cwd: root }).defineEnvValidations(redis)
    expect(kept).toEqual([])
    expect(read()).toBe(
      ENV_FILE.replace(
        '  PORT: Env.schema.number(),\n',
        `  PORT: Env.schema.number(),\n${REDIS_BLOCK}`,
      ),
    )
  })

  it('writes a blank line and no comment block when no comment is given', async () => {
    fs.writeFileSync(envPath, ENV_FILE)
    await createCodemods({ cwd: root }).defineEnvValidations({
      variables: { LOCK_STORE: "Env.schema.enum(['redis', 'memory'] as const)" },
    })
    expect(read()).toBe(
      ENV_FILE.replace(
        '  PORT: Env.schema.number(),\n',
        "  PORT: Env.schema.number(),\n\n  LOCK_STORE: Env.schema.enum(['redis', 'memory'] as const),\n",
      ),
    )
  })

  it('is idempotent: a second run changes nothing', async () => {
    fs.writeFileSync(envPath, ENV_FILE)
    const codemods = createCodemods({ cwd: root })
    await codemods.defineEnvValidations(redis)
    const once = read()
    expect(await codemods.defineEnvValidations(redis)).toEqual([])
    expect(read()).toBe(once)
  })

  it('keeps an edited rule and reports it, unless asked to overwrite', async () => {
    fs.writeFileSync(
      envPath,
      ENV_FILE.replace('  PORT:', '  REDIS_HOST: Env.schema.string(),\n  PORT:'),
    )
    const codemods = createCodemods({ cwd: root })
    expect(await codemods.defineEnvValidations(redis)).toEqual(['REDIS_HOST'])
    expect(read()).toContain('  REDIS_HOST: Env.schema.string(),\n')
    // One of the set already existed: no comment block for the rest.
    expect(read()).not.toContain('Redis connection')
    expect(read()).toContain('  REDIS_PORT: Env.schema.number(),\n')

    expect(await codemods.defineEnvValidations({ ...redis, overwrite: true })).toEqual([])
    expect(read()).toContain("  REDIS_HOST: Env.schema.string({ format: 'host' }),\n")
    expect(read()).not.toContain('  REDIS_HOST: Env.schema.string(),\n')
  })

  it('does not report a rule that only differs in whitespace', async () => {
    fs.writeFileSync(
      envPath,
      ENV_FILE.replace('  PORT:', "  REDIS_HOST: Env.schema.string({format:'host'}),\n  PORT:"),
    )
    expect(await createCodemods({ cwd: root }).defineEnvValidations(redis)).toEqual([])
  })

  it('finds a quoted key', async () => {
    fs.writeFileSync(
      envPath,
      ENV_FILE.replace('  PORT:', "  'REDIS_PORT': Env.schema.number(),\n  PORT:"),
    )
    await createCodemods({ cwd: root }).defineEnvValidations(redis)
    expect(read().match(/REDIS_PORT/g)).toHaveLength(1)
  })

  it('adds the comma the last rule was missing', async () => {
    fs.writeFileSync(
      envPath,
      ENV_FILE.replace('  PORT: Env.schema.number(),', '  PORT: Env.schema.number()'),
    )
    await createCodemods({ cwd: root }).defineEnvValidations(redis)
    expect(read()).toBe(
      ENV_FILE.replace(
        '  PORT: Env.schema.number(),\n',
        `  PORT: Env.schema.number(),\n${REDIS_BLOCK}`,
      ),
    )
  })

  it('keeps a trailing comment and a comma inside a string intact', async () => {
    const source = ENV_FILE.replace(
      '  PORT: Env.schema.number(),\n',
      "  PORT: Env.schema.number() // the port, ok\n  // DB_URL: Env.schema.string('a,b'),\n",
    )
    fs.writeFileSync(envPath, source)
    await createCodemods({ cwd: root }).defineEnvValidations({
      variables: { DB_URL: 'Env.schema.string()' },
    })
    expect(read()).toBe(
      ENV_FILE.replace(
        '  PORT: Env.schema.number(),\n',
        "  PORT: Env.schema.number(), // the port, ok\n  // DB_URL: Env.schema.string('a,b'),\n\n  DB_URL: Env.schema.string(),\n",
      ),
    )
  })

  it('ignores an Env.create mentioned in a comment or a string', async () => {
    fs.writeFileSync(
      envPath,
      `// Env.create(x, { NOPE: 1 })\nconst s = 'Env.create(y, { NOPE: 2 })'\n${ENV_FILE}`,
    )
    await createCodemods({ cwd: root }).defineEnvValidations(redis)
    expect(read()).toContain(`  PORT: Env.schema.number(),\n${REDIS_BLOCK}})`)
    expect(read()).toContain('{ NOPE: 1 }')
    expect(read()).toContain('{ NOPE: 2 }')
  })

  it('fills an empty schema object', async () => {
    fs.writeFileSync(
      envPath,
      "export default await Env.create(new URL('../', import.meta.url), {})\n",
    )
    await createCodemods({ cwd: root }).defineEnvValidations({
      variables: { PORT: 'Env.schema.number()' },
    })
    expect(read()).toBe(
      "export default await Env.create(new URL('../', import.meta.url), {\n  PORT: Env.schema.number(),\n})\n",
    )
  })

  it('preserves CRLF line endings', async () => {
    fs.writeFileSync(envPath, ENV_FILE.replace(/\n/g, '\r\n'))
    await createCodemods({ cwd: root }).defineEnvValidations(redis)
    const out = read()
    expect(out).toBe(
      ENV_FILE.replace(
        '  PORT: Env.schema.number(),\n',
        `  PORT: Env.schema.number(),\n${REDIS_BLOCK}`,
      ).replace(/\n/g, '\r\n'),
    )
  })

  it('says what is missing when there is no env file, no Env.create, or no schema object', async () => {
    const codemods = createCodemods({ cwd: root })
    await expect(codemods.defineEnvValidations(redis)).rejects.toThrow(/start\/env\.ts not found/)
    fs.writeFileSync(envPath, 'export default {}\n')
    await expect(codemods.defineEnvValidations(redis)).rejects.toThrow(/Env\.create/)
    fs.writeFileSync(
      envPath,
      "const schema = {}\nexport default await Env.create(new URL('../', import.meta.url), schema)\n",
    )
    await expect(codemods.defineEnvValidations(redis)).rejects.toThrow(/object literal/)
  })

  it('refuses a variable name or a rule that would rewrite the file around it', async () => {
    fs.writeFileSync(envPath, ENV_FILE)
    const codemods = createCodemods({ cwd: root })
    const cases: Array<Record<string, string>> = [
      { 'A: 1, B': 'Env.schema.string()' },
      { 'X\n': 'Env.schema.string()' },
      { OK: 'Env.schema.string()}), evil({' },
      { OK: 'Env.schema.string(), INJECTED: Env.schema.string()' },
      { OK: "Env.schema.string('unterminated)" },
      { OK: '' },
      { OK: 'Env.schema.string() // swallows the comma' },
    ]
    for (const variables of cases) {
      await expect(codemods.defineEnvValidations({ variables })).rejects.toThrow(/\[configure\]/)
    }
    await expect(
      codemods.defineEnvValidations({
        leadingComment: 'x */ evil() /*',
        variables: { OK: 'Env.schema.string()' },
      }),
    ).rejects.toThrow(/\[configure\]/)
    expect(read()).toBe(ENV_FILE)
  })

  it('refuses to follow a symlinked env file pointing outside the project root', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codemods-env-outside-'))
    try {
      const target = path.join(outside, 'env.ts')
      fs.writeFileSync(target, ENV_FILE)
      fs.symlinkSync(target, envPath)
      await expect(createCodemods({ cwd: root }).defineEnvValidations(redis)).rejects.toThrow(
        /Symlink escape/,
      )
      expect(fs.readFileSync(target, 'utf8')).toBe(ENV_FILE)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})
