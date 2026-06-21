import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Env, EnvValidationException } from '../../src/env/Env.js'

/**
 * Env mirrors `@adonisjs/core/env`: load + validate + typed `get`. These tests
 * drive `process.env` directly (no .env file needed) — `Env.create` reads it
 * after loading any files. The app root points at a dir with no `.env`, so only
 * the explicitly-set vars are seen.
 */
const EMPTY_ROOT = new URL('./__env_fixtures__/', import.meta.url)

const KEYS = ['HOST', 'PORT', 'FLAG', 'MODE', 'OPT', 'MAIL', 'SITE'] as const

describe('ream > Env', () => {
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k]
  })
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('validates + coerces types, and get() returns them', async () => {
    process.env.HOST = 'localhost'
    process.env.PORT = '3333'
    process.env.FLAG = 'true'
    process.env.MODE = 'production'

    const env = await Env.create(EMPTY_ROOT, {
      HOST: Env.schema.string({ format: 'host' }),
      PORT: Env.schema.number(),
      FLAG: Env.schema.boolean(),
      MODE: Env.schema.enum(['development', 'production', 'test'] as const),
    })

    expect(env.get('HOST')).toBe('localhost')
    expect(env.get('PORT')).toBe(3333)
    expect(env.get('FLAG')).toBe(true)
    expect(env.get('MODE')).toBe('production')
  })

  it('treats absent/empty optional vars as undefined, with get() fallback', async () => {
    delete process.env.OPT
    const env = await Env.create(EMPTY_ROOT, {
      OPT: Env.schema.string.optional(),
    })
    expect(env.get('OPT')).toBeUndefined()
    expect(env.get('OPT', 'fallback')).toBe('fallback')
  })

  it('aggregates every failure into E_INVALID_ENV_VARIABLES', async () => {
    delete process.env.HOST // missing required
    process.env.PORT = 'not-a-number' // invalid number

    let thrown: unknown
    try {
      await Env.create(EMPTY_ROOT, {
        HOST: Env.schema.string(),
        PORT: Env.schema.number(),
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(EnvValidationException)
    if (thrown instanceof EnvValidationException) {
      expect(thrown.name).toBe('E_INVALID_ENV_VARIABLES')
      expect(thrown.help).toContain('HOST')
      expect(thrown.help).toContain('PORT')
    }
  })

  it('enforces string formats (email/host)', async () => {
    process.env.MAIL = 'not-an-email'
    await expect(
      Env.create(EMPTY_ROOT, { MAIL: Env.schema.string({ format: 'email' }) }),
    ).rejects.toBeInstanceOf(EnvValidationException)

    process.env.MAIL = 'a@b.co'
    const env = await Env.create(EMPTY_ROOT, {
      MAIL: Env.schema.string({ format: 'email' }),
    })
    expect(env.get('MAIL')).toBe('a@b.co')
  })

  it('rejects an enum value outside the allowed set', async () => {
    process.env.MODE = 'staging'
    await expect(
      Env.create(EMPTY_ROOT, {
        MODE: Env.schema.enum(['development', 'production', 'test'] as const),
      }),
    ).rejects.toBeInstanceOf(EnvValidationException)
  })
})
