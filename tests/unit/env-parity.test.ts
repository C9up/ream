import { afterEach, describe, expect, it } from 'vitest'
import { Env } from '../../src/env/Env.js'
import {
  applyIdentifier,
  defineIdentifier,
  interpolate,
  removeIdentifier,
} from '../../src/env/interpolate.js'
import { Secret } from '../../src/env/Secret.js'
import { errors } from '../../src/errors/aggregate.js'

const NOWHERE = new URL('file:///ream-env-tests-nonexistent/')

/**
 * The `help` of the `E_INVALID_ENV_VARIABLES` a validation throws: its message
 * is the generic one, the failing variable is on `help`.
 */
function failureHelp(validate: () => unknown): string {
  try {
    validate()
  } catch (error) {
    expect(error).toBeInstanceOf(errors.E_INVALID_ENV_VARIABLES)
    expect(error).toHaveProperty(
      'message',
      'Validation failed for one or more environment variables',
    )
    return error instanceof errors.E_INVALID_ENV_VARIABLES ? (error.help ?? '') : ''
  }
  throw new Error('the validation did not throw')
}

describe('Env.schema.secret (AdonisJS parity)', () => {
  it('wraps the value in a Secret that redacts but can be released', () => {
    const value = Env.schema.secret().validate('APP_KEY', 's3cr3t')
    expect(value).toBeInstanceOf(Secret)
    expect(value.release()).toBe('s3cr3t')
    expect(String(value)).toBe('[redacted]')
    expect(JSON.stringify({ key: value })).toBe('{"key":"[redacted]"}')
  })

  it('optional secret returns undefined for an absent value', () => {
    expect(Env.schema.secret().optional().validate('APP_KEY', undefined)).toBeUndefined()
  })

  it('required secret throws when absent', () => {
    expect(failureHelp(() => Env.schema.secret().validate('APP_KEY', ''))).toMatch(/^- .*APP_KEY/)
  })
})

describe('Env.schema string uuid format + custom message', () => {
  it('accepts a valid uuid and rejects a non-uuid', () => {
    const node = Env.schema.string({ format: 'uuid' })
    expect(node.validate('ID', '3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(
      '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    )
    expect(failureHelp(() => node.validate('ID', 'not-a-uuid'))).toMatch(/valid uuid/)
  })

  it('uses a custom message when provided', () => {
    expect(
      failureHelp(() =>
        Env.schema.number({ message: 'PORT must be numeric' }).validate('PORT', 'x'),
      ),
    ).toBe('- PORT must be numeric')
  })
})

describe('Env.schema optionalWhen', () => {
  it('is optional when the condition holds', () => {
    expect(Env.schema.string().optionalWhen(true).validate('X', undefined)).toBeUndefined()
  })

  it('is required when the condition is false', () => {
    expect(
      failureHelp(() => Env.schema.string().optionalWhen(false).validate('X', undefined)),
    ).toMatch(/X/)
  })

  it('accepts a predicate condition', () => {
    const node = Env.schema.number().optionalWhen((_name, value) => value === undefined)
    expect(node.validate('X', undefined)).toBeUndefined()
    expect(node.validate('X', '5')).toBe(5)
  })
})

describe('Env.get / set (AdonisJS parity)', () => {
  const saved = { ...process.env }
  afterEach(() => {
    for (const k of ['PORT', 'UNVALIDATED']) delete process.env[k]
    if (saved.PORT !== undefined) process.env.PORT = saved.PORT
  })

  it('reads a validated key, sets it, and falls back to process.env for unknown keys', async () => {
    process.env.PORT = '3000'
    const env = await Env.create(NOWHERE, { PORT: Env.schema.number() })
    expect(env.get('PORT')).toBe(3000)

    env.set('PORT', 4000)
    expect(env.get('PORT')).toBe(4000)
    expect(process.env.PORT).toBe('4000')

    // Unknown key → raw process.env fallback + default.
    process.env.UNVALIDATED = 'xyz'
    expect(env.get('UNVALIDATED')).toBe('xyz')
    expect(env.get('ABSENT', 'fallback')).toBe('fallback')
  })
})

describe('env interpolation', () => {
  it('substitutes bare and braced references', () => {
    const lookup = (name: string) => ({ HOST: 'localhost', PORT: '5432' })[name]
    // Build the braced form by concatenation so the literal isn't mistaken for
    // a template placeholder (it's the interpolation INPUT under test).
    const braced = `$${'{HOST}'}`
    expect(interpolate('$HOST:$PORT', lookup)).toBe('localhost:5432')
    expect(interpolate(`pg://${braced}/db`, lookup)).toBe('pg://localhost/db')
  })

  it('expands a missing reference to empty and honours the \\$ escape', () => {
    expect(interpolate('$MISSING', () => undefined)).toBe('')
    expect(interpolate('\\$LITERAL', () => 'x')).toBe('$LITERAL')
  })

  it('applies a registered identifier resolver', () => {
    defineIdentifier('base64', (v) => Buffer.from(v, 'base64').toString('utf8'))
    try {
      expect(applyIdentifier('base64:aGVsbG8=', 'KEY', NOWHERE)).toBe('hello')
      // Unregistered prefixes (e.g. a postgres URL) are left untouched.
      expect(applyIdentifier('postgres://u:p@h/db', 'KEY', NOWHERE)).toBe('postgres://u:p@h/db')
    } finally {
      removeIdentifier('base64')
    }
  })
})
