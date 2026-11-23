import { Exception } from '@c9up/flare'
import { describe, expect, it } from 'vitest'
import { describeFrameworkError } from '../../src/errors/prettyPrintError.js'
import {
  createPipelineError,
  didYouMean,
  errorDocsUrl,
  errors,
  findClosestMatches,
  levenshtein,
  validatePipelineConfig,
} from '../../src/index.js'
import { defined } from '../__helpers__/defined.js'

describe('error-dx > framework errors', () => {
  it('links a code to its row in the error index', () => {
    expect(errorDocsUrl('E_CONTAINER_NOT_FOUND')).toBe(
      'https://reamjs.com/en/reference/errors#e-container-not-found',
    )
  })

  it('renders code, message, advice and docs link in a box', () => {
    const error = new errors.E_CONTAINER_NOT_FOUND(['mailer', ''])
    error.help = 'Register it in a provider'
    const output = describeFrameworkError(error)
    expect(output).toContain('┌')
    expect(output).toContain('└')
    expect(output).toContain('[E_CONTAINER_NOT_FOUND]')
    expect(output).toContain("No binding found for 'mailer'.")
    expect(output).toContain('Hint: Register it in a provider')
    expect(output).toContain('Docs: https://reamjs.com/en/reference/errors#e-container-not-found')
  })

  it('every error of the bag is a flare Exception named by its code', () => {
    for (const [code, ErrorClass] of Object.entries(errors)) {
      expect(ErrorClass.prototype).toBeInstanceOf(Exception)
      // The one exception, as upstream: the abort error is an
      // `E_HTTP_EXCEPTION` built by `invoke()`, and carries that code.
      const expected = code === 'E_HTTP_REQUEST_ABORTED' ? 'E_HTTP_EXCEPTION' : code
      expect(Reflect.get(ErrorClass, 'code') ?? code).toBe(expected)
    }
  })
})

// === Story 12.2: Fuzzy matching ===

describe('error-dx > Levenshtein distance', () => {
  it('identical strings = 0', () => {
    expect(levenshtein('hello', 'hello')).toBe(0)
  })

  it('single insertion = 1', () => {
    expect(levenshtein('cat', 'cats')).toBe(1)
  })

  it('single deletion = 1', () => {
    expect(levenshtein('cats', 'cat')).toBe(1)
  })

  it('single substitution = 1', () => {
    expect(levenshtein('cat', 'car')).toBe(1)
  })

  it('multiple edits', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3)
  })

  it('empty strings', () => {
    expect(levenshtein('', '')).toBe(0)
    expect(levenshtein('abc', '')).toBe(3)
    expect(levenshtein('', 'abc')).toBe(3)
  })
})

describe('error-dx > findClosestMatches', () => {
  const candidates = ['status', 'total', 'createdAt', 'updatedAt', 'orderId']

  it('finds close matches for typo', () => {
    const matches = findClosestMatches('statsu', candidates)
    expect(defined(matches[0]).candidate).toBe('status')
    expect(defined(matches[0]).distance).toBe(2)
  })

  it('finds matches within max distance', () => {
    const matches = findClosestMatches('ttotal', candidates, 2)
    expect(matches.length).toBeGreaterThan(0)
    expect(defined(matches[0]).candidate).toBe('total')
  })

  it('returns empty for no close match', () => {
    const matches = findClosestMatches('xyzabc', candidates, 2)
    expect(matches).toEqual([])
  })

  it('limits results', () => {
    const matches = findClosestMatches('a', ['ab', 'ac', 'ad', 'ae', 'af'], 3, 2)
    expect(matches.length).toBeLessThanOrEqual(2)
  })

  it('case-insensitive matching', () => {
    const matches = findClosestMatches('STATSU', candidates)
    expect(matches.length).toBeGreaterThan(0)
    expect(defined(matches[0]).candidate).toBe('status')
  })
})

describe('error-dx > didYouMean', () => {
  it('suggests single match', () => {
    const result = didYouMean('statsu', ['status', 'total'])
    expect(result).toBe("Did you mean 'status'?")
  })

  it('suggests multiple matches', () => {
    const result = didYouMean('orde', ['order', 'orderId', 'orders'])
    expect(result).toContain('Did you mean one of:')
  })

  it('returns empty for no match', () => {
    const result = didYouMean('xyzxyz', ['status', 'total'])
    expect(result).toBe('')
  })
})

// === Story 12.3: Pipeline stage errors ===

describe('error-dx > Pipeline stage errors', () => {
  it('createPipelineError includes stage position', () => {
    const original = new Error('Token expired')
    const err = createPipelineError(4, original) // Guard stage

    expect(err.pipelineStage).toBe('5/10 (Guard)')
    expect(err.context.stage).toBe('Guard')
    expect(err.context.position).toBe('5/10')
    expect(err.context.nextStage).toBe('Validate')
    expect(err.help).toContain('5/10')
    expect(err.help).toContain('Guard')
    expect(err.help).toContain('Validate')
    expect(err.code).toBe('E_PIPELINE_ERROR')
    expect(err.cause).toBe(original)
  })

  it('createPipelineError keeps the code of a coded error', () => {
    const original = new Exception('Not authenticated', {
      code: 'E_UNAUTHORIZED_ACCESS',
      status: 401,
    })
    const err = createPipelineError(4, original)

    expect(err.code).toBe('E_UNAUTHORIZED_ACCESS')
    expect(err.message).toBe('Not authenticated')
    expect(err.cause).toBe(original)
  })

  it('last stage shows (end) as next', () => {
    const err = createPipelineError(9, new Error('Logging failed'))
    expect(err.context.nextStage).toBe('(end)')
  })

  it('clamps out-of-range stage index to last stage', () => {
    const err = createPipelineError(99, new Error('Unknown'))
    expect(err.context.stage).toBe('Response Logging')
    expect(err.context.position).toBe('10/10')
    expect(err.context.nextStage).toBe('(end)')
  })

  it('clamps negative stage index to first stage', () => {
    const err = createPipelineError(-1, new Error('Early'))
    expect(err.context.stage).toBe('Security (Blackhole)')
    expect(err.context.position).toBe('1/10')
  })
})

describe('error-dx > validatePipelineConfig', () => {
  it('returns empty for valid config', () => {
    const found = validatePipelineConfig({
      namedMiddleware: { auth: () => {}, throttle: () => {} },
      routes: [{ middleware: ['auth'] }],
    })
    expect(found).toEqual([])
  })

  it('detects unknown middleware on routes', () => {
    const found = validatePipelineConfig({
      namedMiddleware: { auth: () => {} },
      routes: [{ middleware: ['auth', 'nonexistent'] }],
    })
    expect(found).toHaveLength(1)
    expect(defined(found[0]).code).toBe('E_PIPELINE_UNKNOWN_MIDDLEWARE')
    expect(defined(found[0]).message).toContain('nonexistent')
    expect(defined(found[0]).registered).toContain('auth')
  })

  it('returns empty when no routes', () => {
    const found = validatePipelineConfig({})
    expect(found).toEqual([])
  })
})
