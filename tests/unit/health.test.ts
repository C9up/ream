/**
 * The health module, ported from `@adonisjs/core/health`.
 *
 * Two things get the most attention here. The cache is one: a check that says
 * `cacheFor` must not run again inside its window, and must run again once the
 * window closes — a cache that never expires and a cache that never hits look
 * identical from a single call. The other is `DiskSpaceCheck`'s default
 * reading, which is the one place this module does not copy upstream: it reads
 * `fs.statfs` where AdonisJS shells out through `check-disk-space`, so the
 * numbers it returns are verified against the real filesystem rather than a
 * stub that would agree with any implementation.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  BaseCheck,
  DiskSpaceCheck,
  HealthChecks,
  MemoryHeapCheck,
  MemoryRSSCheck,
  Result,
  tracingChannels,
} from '../../src/health/index.js'
import type { HealthCheckResult } from '../../src/health/types.js'
import bytes from '../../src/helpers/bytes.js'
import { defined } from '../__helpers__/defined.js'

/** A check whose verdict and run-count the test controls. */
class StubCheck extends BaseCheck {
  name = 'stub'
  runs = 0
  readonly #verdict: () => Result

  constructor(verdict: () => Result) {
    super()
    this.#verdict = verdict
  }

  async run(): Promise<HealthCheckResult> {
    this.runs++
    return this.#verdict()
  }
}

describe('Result', () => {
  it('builds each status', () => {
    expect(Result.ok('fine').status).toBe('ok')
    expect(Result.warning('hmm').status).toBe('warning')
    expect(Result.failed('broken').status).toBe('error')
  })

  it('carries the error it was given, under either overload', () => {
    const err = new Error('connection timeout')
    expect(Result.failed('db down', err).meta).toEqual({ error: err })

    const fromError = Result.failed(err)
    expect(fromError.message).toBe('connection timeout')
    expect(fromError.meta).toEqual({ error: err })
  })

  it('setMetaData replaces and mergeMetaData merges', () => {
    const r = Result.ok('up').setMetaData({ a: 1, b: 2 })
    expect(r.meta).toEqual({ a: 1, b: 2 })
    r.setMetaData({ c: 3 })
    expect(r.meta).toEqual({ c: 3 })
    r.mergeMetaData({ d: 4 })
    expect(r.meta).toEqual({ c: 3, d: 4 })
  })

  it('leaves meta out of the JSON when there is none', () => {
    expect(Object.hasOwn(Result.ok('up').toJSON(), 'meta')).toBe(false)
    expect(Result.ok('up').setMetaData({ a: 1 }).toJSON().meta).toEqual({ a: 1 })
  })
})

describe('BaseCheck', () => {
  it('as() renames, so two instances of one check stay apart', () => {
    const check = new StubCheck(() => Result.ok('up')).as('primary db')
    expect(check.name).toBe('primary db')
  })

  it('cacheFor accepts seconds and a human duration alike', () => {
    expect(new StubCheck(() => Result.ok('up')).cacheFor(60).cacheDuration).toBe(60)
    expect(new StubCheck(() => Result.ok('up')).cacheFor('1 minute').cacheDuration).toBe(60)
    expect(new StubCheck(() => Result.ok('up')).cacheFor('2h').cacheDuration).toBe(7200)
  })
})

describe('HealthChecks — aggregation', () => {
  it('error beats warning beats ok, and only error is unhealthy', async () => {
    const report = await new HealthChecks()
      .register([
        new StubCheck(() => Result.ok('a')).as('a'),
        new StubCheck(() => Result.warning('b')).as('b'),
      ])
      .run()
    expect(report.status).toBe('warning')
    expect(report.isHealthy).toBe(true)

    const withError = await new HealthChecks()
      .register([
        new StubCheck(() => Result.warning('b')).as('b'),
        new StubCheck(() => Result.failed('c')).as('c'),
      ])
      .run()
    expect(withError.status).toBe('error')
    expect(withError.isHealthy).toBe(false)
  })

  it('an empty registry is healthy', async () => {
    const report = await new HealthChecks().run()
    expect(report).toMatchObject({ status: 'ok', isHealthy: true, checks: [] })
  })

  it('append adds to the registry, register replaces it', async () => {
    const checks = new HealthChecks()
      .register([new StubCheck(() => Result.ok('a')).as('a')])
      .append([new StubCheck(() => Result.ok('b')).as('b')])
    expect((await checks.run()).checks.map((c) => c.name)).toEqual(['a', 'b'])

    checks.register([new StubCheck(() => Result.ok('c')).as('c')])
    expect((await checks.run()).checks.map((c) => c.name)).toEqual(['c'])
  })

  it('reports the process it ran in', async () => {
    const { debugInfo } = await new HealthChecks().run()
    expect(debugInfo.pid).toBe(process.pid)
    expect(debugInfo.platform).toBe(process.platform)
    expect(debugInfo.version).toBe(process.version)
    expect(debugInfo.uptime).toBeGreaterThan(0)
  })
})

describe('HealthChecks — caching', () => {
  it('does not re-run a cached check inside its window, and does after it', async () => {
    vi.useFakeTimers()
    try {
      const check = new StubCheck(() => Result.ok('up')).as('cached')
      check.cacheFor(60)
      const checks = new HealthChecks().register([check])

      const first = await checks.run()
      expect(defined(first.checks[0]).isCached).toBe(false)
      expect(check.runs).toBe(1)

      vi.advanceTimersByTime(59_000)
      const second = await checks.run()
      expect(defined(second.checks[0]).isCached).toBe(true)
      expect(check.runs).toBe(1)

      vi.advanceTimersByTime(2_000)
      const third = await checks.run()
      expect(defined(third.checks[0]).isCached).toBe(false)
      expect(check.runs).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs an uncached check every time', async () => {
    const check = new StubCheck(() => Result.ok('up')).as('uncached')
    const checks = new HealthChecks().register([check])
    await checks.run()
    await checks.run()
    expect(check.runs).toBe(2)
  })
})

describe('HealthChecks — tracing', () => {
  it('publishes each run on the diagnostics channel', async () => {
    const seen: string[] = []
    // `ChannelListener` returns void; `push` returns a number, and a channel
    // handler declared to return one does not fit. And the shape is read, not
    // asserted: what a diagnostics channel publishes is `unknown`.
    // All five handlers: `TracingChannelSubscribers` takes the set, and a
    // partial one is a type error even though `subscribe` tolerates it at
    // runtime. Only `start` is read here.
    const noop = (): void => {}
    const subscriber = {
      end: noop,
      asyncStart: noop,
      asyncEnd: noop,
      error: noop,
      start: (data: unknown): void => {
        if (typeof data !== 'object' || data === null) return
        const check = Reflect.get(data, 'check')
        if (typeof check !== 'object' || check === null) return
        const name = Reflect.get(check, 'name')
        if (typeof name === 'string') seen.push(name)
      },
    }
    tracingChannels.healthCheck.subscribe(subscriber)
    try {
      await new HealthChecks().register([new StubCheck(() => Result.ok('up')).as('traced')]).run()
      expect(seen).toContain('traced')
    } finally {
      tracingChannels.healthCheck.unsubscribe(subscriber)
    }
  })
})

describe('memory checks', () => {
  const usage = (over: Partial<NodeJS.MemoryUsage>): NodeJS.MemoryUsage => ({
    rss: 0,
    heapTotal: 0,
    heapUsed: 0,
    external: 0,
    arrayBuffers: 0,
    ...over,
  })

  it('MemoryRSSCheck crosses ok -> warning -> error at its byte thresholds', async () => {
    const build = (rss: number) =>
      new MemoryRSSCheck()
        .warnWhenExceeds('100 mb')
        .failWhenExceeds('200 mb')
        .compute(() => usage({ rss }))

    expect((await build(50 * 1024 ** 2).run()).status).toBe('ok')
    expect((await build(150 * 1024 ** 2).run()).status).toBe('warning')
    expect((await build(250 * 1024 ** 2).run()).status).toBe('error')
  })

  it('MemoryHeapCheck does the same on heapUsed, not rss', async () => {
    const check = new MemoryHeapCheck()
      .warnWhenExceeds('100 mb')
      .failWhenExceeds('200 mb')
      .compute(() => usage({ rss: 900 * 1024 ** 2, heapUsed: 10 * 1024 ** 2 }))
    // A huge RSS must not colour a heap check.
    expect((await check.run()).status).toBe('ok')
  })

  it('reports what it measured and what it compared against', async () => {
    const result = await new MemoryRSSCheck()
      .warnWhenExceeds('100 mb')
      .failWhenExceeds('200 mb')
      .compute(() => usage({ rss: 250 * 1024 ** 2 }))
      .run()

    expect(result.message).toContain('250MB')
    expect(result.message).toContain('200MB')
    expect(result.meta?.memoryInBytes).toEqual({
      used: 250 * 1024 ** 2,
      warningThreshold: 100 * 1024 ** 2,
      failureThreshold: 200 * 1024 ** 2,
    })
  })

  it('a percentage threshold replaces the byte threshold rather than joining it', async () => {
    const check = new MemoryRSSCheck()
      .failWhenExceeds('1 kb') // would fail on any real process
      .failWhenExceedsPercentage(99) // ...but this supersedes it
      .warnWhenExceedsPercentage(98)
      .compute(() => usage({ rss: 1024 }))

    const result = await check.run()
    expect(result.status).toBe('ok')
    expect(result.meta?.sizeInPercentage).toMatchObject({
      failureThreshold: 99,
      warningThreshold: 98,
    })
  })

  it('rejects a percentage outside 0-100 and an unreadable size', () => {
    expect(() => new MemoryRSSCheck().warnWhenExceedsPercentage(101)).toThrow(/between 0 and 100/)
    expect(() => new MemoryHeapCheck().failWhenExceedsPercentage(-1)).toThrow(/between 0 and 100/)
    expect(() => new MemoryRSSCheck().warnWhenExceeds('plenty')).toThrow(/Invalid byte value/)
  })
})

describe('DiskSpaceCheck', () => {
  it('crosses its thresholds on the used percentage', async () => {
    const at = (usedPercent: number) =>
      new DiskSpaceCheck()
        .warnWhenExceeds(70)
        .failWhenExceeds(85)
        .compute(async () => ({ size: 100, free: 100 - usedPercent }))

    expect((await at(50).run()).status).toBe('ok')
    expect((await at(75).run()).status).toBe('warning')
    expect((await at(90).run()).status).toBe('error')
  })

  it('reads the real filesystem by default — the statfs deviation', async () => {
    // This is the assertion that matters: upstream shells out to `df`, we read
    // fs.statfs. If the numbers were wrong or the call threw, every disk check
    // in production would silently report a bogus percentage.
    const result = await new DiskSpaceCheck().run()

    expect(['ok', 'warning', 'error']).toContain(result.status)
    const meta = result.meta?.sizeInPercentage
    expect(meta).toBeDefined()
    const used = (meta as { used: number }).used
    expect(Number.isInteger(used)).toBe(true)
    expect(used).toBeGreaterThanOrEqual(0)
    expect(used).toBeLessThanOrEqual(100)
  })

  it('measures the path it was pointed at', async () => {
    const check = new DiskSpaceCheck()
    check.diskPath = process.cwd()
    expect((await check.run()).meta?.sizeInPercentage).toBeDefined()
  })
})

describe('string.bytes helper', () => {
  it('parses the units upstream accepts, case-insensitively', () => {
    expect(bytes.parse('1kb')).toBe(1024)
    expect(bytes.parse('1 KB')).toBe(1024)
    expect(bytes.parse('1.5mb')).toBe(Math.floor(1.5 * 1024 ** 2))
    expect(bytes.parse('2 gb')).toBe(2 * 1024 ** 3)
  })

  it('reads a bare number as bytes, and passes a number through', () => {
    expect(bytes.parse('1024')).toBe(1024)
    expect(bytes.parse(1024)).toBe(1024)
  })

  it('returns null rather than throwing on nonsense', () => {
    expect(bytes.parse('plenty')).toBeNull()
    expect(bytes.parse(Number.NaN)).toBeNull()
    expect(bytes.format(Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('formats with the largest unit that leaves a value above one', () => {
    expect(bytes.format(1024)).toBe('1KB')
    expect(bytes.format(512)).toBe('512B')
    expect(bytes.format(1024 ** 3)).toBe('1GB')
    expect(bytes.format(1536)).toBe('1.5KB')
  })
})
