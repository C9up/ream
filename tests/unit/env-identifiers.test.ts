/**
 * `.env` identifiers and nested references — `@adonisjs/env`'s `EnvParser`
 * rules: the built-in `file:` identifier, the `identifier\:` escape, a
 * registry that refuses a second definition, async resolvers, and references
 * resolved through the referenced value's own interpolation.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Env } from '../../src/env/Env.js'
import { defineIdentifier, removeIdentifier } from '../../src/env/interpolate.js'
import { loadEnvFiles } from '../../src/env/loadEnvFiles.js'

const KEYS = [
  'REAM_EI_PASSWORD',
  'REAM_EI_ABSOLUTE',
  'REAM_EI_MISSING',
  'REAM_EI_LITERAL',
  'REAM_EI_URL',
  'REAM_EI_USER',
  'REAM_EI_BASE',
  'REAM_EI_KEY',
  'REAM_EI_ASYNC',
  'REAM_EI_A',
  'REAM_EI_B',
]
const dirs: string[] = []

function app(files: Record<string, string>): URL {
  const dir = mkdtempSync(join(tmpdir(), 'ream-env-id-'))
  dirs.push(dir)
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), contents)
  }
  return pathToFileURL(`${dir}/`)
}

afterEach(() => {
  for (const key of KEYS) delete process.env[key]
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  removeIdentifier('reamtest')
})

describe('env > file: identifier', () => {
  it('reads the file relative to the application root, verbatim', async () => {
    const root = app({ '.env': 'REAM_EI_PASSWORD=file:secrets/db\n', 'secrets/db': 's3cr3t' })
    const env = await Env.create(root, { REAM_EI_PASSWORD: Env.schema.string() })
    expect(env.get('REAM_EI_PASSWORD')).toBe('s3cr3t')
  })

  it('accepts an absolute path', async () => {
    const holder = app({ secret: 'abs' })
    const path = new URL('secret', holder).pathname
    const root = app({ '.env': `REAM_EI_ABSOLUTE=file:${path}\n` })
    await loadEnvFiles(root)
    expect(process.env.REAM_EI_ABSOLUTE).toBe('abs')
  })

  it('refuses to boot on a missing file, naming the variable and the path', async () => {
    const root = app({ '.env': 'REAM_EI_MISSING=file:secrets/nope\n' })
    await expect(loadEnvFiles(root)).rejects.toMatchObject({
      code: 'E_ENV_FILE_NOT_FOUND',
      message: expect.stringMatching(/"REAM_EI_MISSING".*secrets\/nope/),
    })
    expect(process.env.REAM_EI_MISSING).toBeUndefined()
  })

  it('keeps `file\\:x` as the literal `file:x`', async () => {
    const root = app({ '.env': 'REAM_EI_LITERAL=file\\:x\n' })
    await loadEnvFiles(root)
    expect(process.env.REAM_EI_LITERAL).toBe('file:x')
  })
})

describe('env > references and the identifier registry', () => {
  it('resolves a reference through the referenced value, whatever the order', async () => {
    // The braced reference is built by concatenation so the literal is not
    // mistaken for a template placeholder (it is the input under test).
    const braced = `$${'{REAM_EI_BASE}'}`
    const root = app({
      '.env': `REAM_EI_URL=postgres://$REAM_EI_USER@host\nREAM_EI_USER=${braced}_admin\nREAM_EI_BASE=app\n`,
    })
    await loadEnvFiles(root)
    expect(process.env.REAM_EI_URL).toBe('postgres://app_admin@host')
  })

  it('names a reference cycle instead of overflowing the stack', async () => {
    const root = app({ '.env': 'REAM_EI_A=$REAM_EI_B\nREAM_EI_B=$REAM_EI_A\n' })
    await expect(loadEnvFiles(root)).rejects.toMatchObject({ code: 'E_ENV_CIRCULAR_REFERENCE' })
  })

  it('turns `identifier\\:` into a literal `identifier:`', async () => {
    defineIdentifier('reamtest', (value) => value.toUpperCase())
    const root = app({ '.env': 'REAM_EI_KEY=reamtest\\:abc\n' })
    await loadEnvFiles(root)
    expect(process.env.REAM_EI_KEY).toBe('reamtest:abc')
  })

  it('refuses to redefine a taken identifier', () => {
    defineIdentifier('reamtest', (value) => value)
    expect(() => defineIdentifier('reamtest', (value) => value.repeat(2))).toThrow(
      expect.objectContaining({
        code: 'E_IDENTIFIER_ALREADY_DEFINED',
        status: 500,
        message: 'The identifier "reamtest" is already defined',
      }),
    )
    expect(() => Env.defineIdentifier('file', (value) => value)).toThrow(/already defined/)
  })

  it('awaits an async resolver and hands it the key and the app root', async () => {
    const seen: Array<[string, string, string]> = []
    defineIdentifier('reamtest', async (value, key, appRoot) => {
      seen.push([value, key, appRoot.href])
      return `resolved-${value}`
    })
    const root = app({ '.env': 'REAM_EI_ASYNC=reamtest:abc\n' })
    await loadEnvFiles(root)
    expect(process.env.REAM_EI_ASYNC).toBe('resolved-abc')
    expect(seen).toEqual([['abc', 'REAM_EI_ASYNC', root.href]])
  })
})
