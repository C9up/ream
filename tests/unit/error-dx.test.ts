import { describe, expect, it } from 'vitest'
import {
  AtlasError,
  ContainerError,
  ForgeError,
  PipelineError,
  PulsarError,
  ReamError,
  RouterError,
  RuneError,
  WardenError,
  createPipelineError,
  didYouMean,
  findClosestMatches,
  levenshtein,
  validatePipelineConfig,
} from '../../src/index.js'

// === Story 12.1: ReamError structured errors ===

describe('error-dx > ReamError', () => {
  it('includes all required fields', () => {
    const err = new ReamError('TEST_ERROR', 'Something went wrong', {
      context: { key: 'value' },
      hint: 'Try fixing this',
      sourceFile: 'app/Order.ts',
      sourceLine: 42,
    })

    expect(err.code).toBe('TEST_ERROR')
    expect(err.message).toBe('Something went wrong')
    expect(err.context.key).toBe('value')
    expect(err.hint).toBe('Try fixing this')
    expect(err.sourceFile).toBe('app/Order.ts')
    expect(err.sourceLine).toBe(42)
    expect(err.docsUrl).toBe('https://docs.ream.dev/errors/TEST_ERROR')
  })

  it('auto-generates docsUrl from code', () => {
    const err = new ReamError('CONTAINER_NOT_FOUND', 'Not found')
    expect(err.docsUrl).toBe('https://docs.ream.dev/errors/CONTAINER_NOT_FOUND')
  })

  it('allows custom docsUrl', () => {
    const err = new ReamError('CUSTOM', 'msg', { docsUrl: 'https://custom.dev/err' })
    expect(err.docsUrl).toBe('https://custom.dev/err')
  })

  it('toDevString shows full box format', () => {
    const err = new ReamError('ATLAS_QUERY_ERROR', 'Invalid query', {
      context: { table: 'orders', column: 'statsu' },
      hint: "Column 'statsu' does not exist. Did you mean 'status'?",
      sourceFile: 'app/modules/order/services/OrderService.ts',
      sourceLine: 15,
    })

    const output = err.toDevString()
    expect(output).toContain('┌')
    expect(output).toContain('└')
    expect(output).toContain('[ATLAS_QUERY_ERROR]')
    expect(output).toContain('Invalid query')
    expect(output).toContain('table: orders')
    expect(output).toContain('column: statsu')
    expect(output).toContain('Hint:')
    expect(output).toContain('Docs:')
    expect(output).toContain('OrderService.ts:15')
  })

  it('toProdString shows code + message only', () => {
    const err = new ReamError('ATLAS_QUERY_ERROR', 'Invalid query', {
      hint: 'secret hint',
      context: { secret: 'data' },
    })

    const output = err.toProdString()
    expect(output).toBe('[ATLAS_QUERY_ERROR] Invalid query')
    expect(output).not.toContain('hint')
    expect(output).not.toContain('secret')
  })

  it('includes pipeline stage in dev output', () => {
    const err = new ReamError('GUARD_FAILED', 'Unauthorized', {
      pipelineStage: '5/10 (Guard)',
    })

    const output = err.toDevString()
    expect(output).toContain('Pipeline: 5/10 (Guard)')
  })

  it('fromNapi parses JSON error', () => {
    const napiErr = new Error(JSON.stringify({
      code: 'NAPI_ERROR',
      message: 'Rust error',
      hint: 'Check Rust logs',
    }))

    const err = ReamError.fromNapi(napiErr)
    expect(err.code).toBe('NAPI_ERROR')
    expect(err.message).toBe('Rust error')
    expect(err.hint).toBe('Check Rust logs')
  })

  it('fromNapi wraps non-JSON error', () => {
    const napiErr = new Error('plain error')
    const err = ReamError.fromNapi(napiErr)
    expect(err.code).toBe('UNKNOWN')
    expect(err.message).toBe('plain error')
  })
})

// === Module-specific errors ===

describe('error-dx > Module error subclasses', () => {
  it('ContainerError prefixes code', () => {
    const err = new ContainerError('NOT_FOUND', 'Binding missing')
    expect(err.code).toBe('CONTAINER_NOT_FOUND')
    expect(err.name).toBe('ContainerError')
    expect(err instanceof ReamError).toBe(true)
  })

  it('AtlasError prefixes code', () => {
    const err = new AtlasError('QUERY_ERROR', 'Bad query')
    expect(err.code).toBe('ATLAS_QUERY_ERROR')
    expect(err.name).toBe('AtlasError')
  })

  it('RouterError prefixes code', () => {
    const err = new RouterError('NOT_FOUND', 'Route missing')
    expect(err.code).toBe('ROUTER_NOT_FOUND')
  })

  it('PipelineError prefixes code', () => {
    const err = new PipelineError('STAGE_FAILED', 'Guard rejected')
    expect(err.code).toBe('PIPELINE_STAGE_FAILED')
  })

  it('RuneError prefixes code', () => {
    const err = new RuneError('VALIDATION_FAILED', 'Invalid input')
    expect(err.code).toBe('RUNE_VALIDATION_FAILED')
  })

  it('WardenError prefixes code', () => {
    const err = new WardenError('STRATEGY_NOT_FOUND', 'No strategy')
    expect(err.code).toBe('WARDEN_STRATEGY_NOT_FOUND')
  })

  it('PulsarError prefixes code', () => {
    const err = new PulsarError('TIMEOUT', 'Request timed out')
    expect(err.code).toBe('PULSAR_TIMEOUT')
  })

  it('ForgeError prefixes code', () => {
    const err = new ForgeError('UNKNOWN_TYPE', 'Bad type')
    expect(err.code).toBe('FORGE_UNKNOWN_TYPE')
  })

  it('all subclasses inherit docsUrl', () => {
    const err = new AtlasError('QUERY_ERROR', 'Bad query')
    expect(err.docsUrl).toBe('https://docs.ream.dev/errors/ATLAS_QUERY_ERROR')
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
    expect(matches[0].candidate).toBe('status')
    expect(matches[0].distance).toBe(2)
  })

  it('finds matches within max distance', () => {
    const matches = findClosestMatches('ttotal', candidates, 2)
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0].candidate).toBe('total')
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
    expect(matches[0].candidate).toBe('status')
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
    expect(err.hint).toContain('5/10')
    expect(err.hint).toContain('Guard')
    expect(err.hint).toContain('Validate')
  })

  it('createPipelineError preserves ReamError fields', () => {
    const original = new ReamError('WARDEN_UNAUTHORIZED', 'Not authenticated', {
      sourceFile: 'Guard.ts',
      sourceLine: 10,
    })
    const err = createPipelineError(4, original)

    expect(err.code).toBe('WARDEN_UNAUTHORIZED')
    expect(err.sourceFile).toBe('Guard.ts')
    expect(err.sourceLine).toBe(10)
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
    const errors = validatePipelineConfig({
      namedMiddleware: { auth: () => {}, throttle: () => {} },
      routes: [{ middleware: ['auth'] }],
    })
    expect(errors).toEqual([])
  })

  it('detects unknown middleware on routes', () => {
    const errors = validatePipelineConfig({
      namedMiddleware: { auth: () => {} },
      routes: [{ middleware: ['auth', 'nonexistent'] }],
    })
    expect(errors).toHaveLength(1)
    expect(errors[0].code).toBe('PIPELINE_UNKNOWN_MIDDLEWARE')
    expect(errors[0].message).toContain('nonexistent')
    expect(errors[0].context.registered).toContain('auth')
  })

  it('returns empty when no routes', () => {
    const errors = validatePipelineConfig({})
    expect(errors).toEqual([])
  })
})
