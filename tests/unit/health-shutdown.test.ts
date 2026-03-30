import { describe, expect, it } from 'vitest'
import { HealthCheck } from '../../src/HealthCheck.js'

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
    expect(status.checks[0].name).toBe('db')
    expect(status.checks[1].name).toBe('cache')
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

  it('catches checker exceptions', async () => {
    const health = new HealthCheck()
    health.register('broken', () => { throw new Error('boom') })

    const status = await health.check()
    expect(status.status).toBe('error')
    expect(status.checks[0].status).toBe('error')
    expect(status.checks[0].message).toBe('boom')
  })

  it('supports async checkers', async () => {
    const health = new HealthCheck()
    health.register('db', async () => {
      await new Promise((r) => setTimeout(r, 5))
      return { name: 'db', status: 'ok' }
    })

    const status = await health.check()
    expect(status.status).toBe('ok')
    expect(status.checks[0].latency).toBeGreaterThanOrEqual(0)
  })

  it('measures latency per check', async () => {
    const health = new HealthCheck()
    health.register('slow', async () => {
      await new Promise((r) => setTimeout(r, 20))
      return { name: 'slow', status: 'ok' }
    })

    const status = await health.check()
    expect(status.checks[0].latency).toBeGreaterThanOrEqual(15)
  })

  it('handler returns correct HTTP status', async () => {
    const health = new HealthCheck()
    health.register('db', () => ({ name: 'db', status: 'ok' }))

    const ctx = { response: { status: 0, headers: {} as Record<string, string>, body: '' } }
    await health.handler()(ctx)

    expect(ctx.response.status).toBe(200)
    expect(ctx.response.headers['content-type']).toBe('application/json')
    const body = JSON.parse(ctx.response.body)
    expect(body.status).toBe('ok')
  })

  it('handler returns 503 on error', async () => {
    const health = new HealthCheck()
    health.register('db', () => ({ name: 'db', status: 'error', message: 'Down' }))

    const ctx = { response: { status: 0, headers: {} as Record<string, string>, body: '' } }
    await health.handler()(ctx)

    expect(ctx.response.status).toBe(503)
  })

  it('handler returns 503 on degraded (K8s readiness)', async () => {
    const health = new HealthCheck()
    health.register('cache', () => ({ name: 'cache', status: 'warn', message: 'Slow' }))

    const ctx = { response: { status: 0, headers: {} as Record<string, string>, body: '' } }
    await health.handler()(ctx)

    expect(ctx.response.status).toBe(503)
    const body = JSON.parse(ctx.response.body)
    expect(body.status).toBe('degraded')
  })

  it('enforces registration name over checker name', async () => {
    const health = new HealthCheck()
    health.register('database', () => ({ name: 'wrong_name', status: 'ok' }))

    const status = await health.check()
    expect(status.checks[0].name).toBe('database')
  })

  it('times out hung checkers', async () => {
    const health = new HealthCheck({ checkTimeout: 50 })
    health.register('hung', () => new Promise(() => {})) // never resolves

    const status = await health.check()
    expect(status.status).toBe('error')
    expect(status.checks[0].status).toBe('error')
    expect(status.checks[0].message).toContain('timed out')
  })
})
