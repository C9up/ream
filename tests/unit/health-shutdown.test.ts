import { describe, expect, it, vi } from 'vitest'
import { HealthCheck } from '../../src/HealthCheck.js'
import { Response } from '../../src/http/Response.js'
import { defined } from '../__helpers__/defined.js'

/**
 * Drive the handler through a REAL Response.
 *
 * These three assertions used to run against `{ response: { status: 0,
 * headers: {}, body: '' } }` — a shape no Ream response has ever had. They
 * passed while the handler could not have worked on a mounted route, which is
 * the whole reason the bug survived. Using the real class is what makes them
 * mean something.
 */
function probe(health: HealthCheck) {
  const response = new Response()
  return { response, run: () => health.handler()({ response }) }
}

describe('health > HealthCheck', () => {
  it('returns ok when no checkers registered', async () => {
    const health = new HealthCheck()
    const status = await health.check()
    expect(status.status).toBe('ok')
    expect(status.checks).toEqual([])
    expect(status.uptime).toBeGreaterThanOrEqual(0)
    expect(status.timestamp).toBeDefined()
  })

  it('aggregates passing checks', async () => {
    const health = new HealthCheck()
    health.register('db', () => ({ name: 'db', status: 'ok', message: 'Connected' }))
    health.register('cache', () => ({ name: 'cache', status: 'ok' }))

    const status = await health.check()
    expect(status.status).toBe('ok')
    expect(status.checks).toHaveLength(2)
    expect(defined(status.checks[0]).name).toBe('db')
    expect(defined(status.checks[1]).name).toBe('cache')
  })

  it('reports degraded when any check warns', async () => {
    const health = new HealthCheck()
    health.register('db', () => ({ name: 'db', status: 'ok' }))
    health.register('cache', () => ({ name: 'cache', status: 'warn', message: 'Slow' }))

    const status = await health.check()
    expect(status.status).toBe('degraded')
  })

  it('reports error when any check fails', async () => {
    const health = new HealthCheck()
    health.register('db', () => ({ name: 'db', status: 'error', message: 'Connection refused' }))
    health.register('cache', () => ({ name: 'cache', status: 'ok' }))

    const status = await health.check()
    expect(status.status).toBe('error')
  })

  it('catches checker exceptions, reporting a fixed message and handing the error to onError', async () => {
    const seen: Array<[string, unknown]> = []
    const health = new HealthCheck({ onError: (name, error) => seen.push([name, error]) })
    const thrown = new Error('connect ECONNREFUSED 10.0.3.17:5432')
    health.register('broken', () => {
      throw thrown
    })

    const status = await health.check()
    expect(status.status).toBe('error')
    expect(defined(status.checks[0]).status).toBe('error')
    expect(defined(status.checks[0]).message).toBe('Health check failed')
    expect(seen).toEqual([['broken', thrown]])
  })

  it('logs the error of a failing check to stderr by default', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const health = new HealthCheck()
      health.register('db', () => {
        throw new Error('password authentication failed for user "app"')
      })
      await health.check()
      expect(write).toHaveBeenCalledWith(
        `[health] check 'db' failed: Error: password authentication failed for user "app"\n`,
      )
    } finally {
      write.mockRestore()
    }
  })

  it('handler answers the fixed message, never what the check threw', async () => {
    const health = new HealthCheck({ onError: () => {} })
    health.register('database', async () => {
      throw new Error('connect ECONNREFUSED 10.0.3.17:5432')
    })
    const { response, run } = probe(health)
    await run()

    expect(response.getStatus()).toBe(503)
    expect(response.getBody()).not.toContain('ECONNREFUSED')
    expect(JSON.parse(response.getBody())).toMatchObject({
      checks: [{ name: 'database', status: 'error', message: 'Health check failed' }],
    })
  })

  it('supports async checkers', async () => {
    const health = new HealthCheck()
    health.register('db', async () => {
      await new Promise((r) => setTimeout(r, 5))
      return { name: 'db', status: 'ok' }
    })

    const status = await health.check()
    expect(status.status).toBe('ok')
    expect(defined(status.checks[0]).latency).toBeGreaterThanOrEqual(0)
  })

  it('measures latency per check', async () => {
    const health = new HealthCheck()
    health.register('slow', async () => {
      await new Promise((r) => setTimeout(r, 20))
      return { name: 'slow', status: 'ok' }
    })

    const status = await health.check()
    expect(defined(status.checks[0]).latency).toBeGreaterThanOrEqual(15)
  })

  it('handler returns correct HTTP status', async () => {
    const health = new HealthCheck()
    health.register('db', () => ({ name: 'db', status: 'ok' }))

    const { response, run } = probe(health)
    await run()

    expect(response.getStatus()).toBe(200)
    expect(response.getHeader('content-type')).toBe('application/json')
    expect(JSON.parse(response.getBody()).status).toBe('ok')
  })

  it('handler returns 503 on error', async () => {
    const health = new HealthCheck()
    health.register('db', () => ({ name: 'db', status: 'error', message: 'Down' }))

    const { response, run } = probe(health)
    await run()

    expect(response.getStatus()).toBe(503)
  })

  it('handler returns 503 on degraded (K8s readiness)', async () => {
    const health = new HealthCheck()
    health.register('cache', () => ({ name: 'cache', status: 'warn', message: 'Slow' }))

    const { response, run } = probe(health)
    await run()

    expect(response.getStatus()).toBe(503)
    expect(JSON.parse(response.getBody()).status).toBe('degraded')
  })

  it('enforces registration name over checker name', async () => {
    const health = new HealthCheck()
    health.register('database', () => ({ name: 'wrong_name', status: 'ok' }))

    const status = await health.check()
    expect(defined(status.checks[0]).name).toBe('database')
  })

  it('times out hung checkers', async () => {
    const health = new HealthCheck({ checkTimeout: 50 })
    health.register('hung', () => new Promise(() => {})) // never resolves

    const status = await health.check()
    expect(status.status).toBe('error')
    expect(defined(status.checks[0]).status).toBe('error')
    expect(defined(status.checks[0]).message).toContain('timed out')
  })
})
