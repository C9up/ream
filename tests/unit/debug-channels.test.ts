import { describe, expect, it } from 'vitest'
import { debugCore, debugHttp } from '../../src/debug.js'

/**
 * AdonisJS traces its HTTP plumbing through `util.debuglog`, off unless
 * `NODE_DEBUG` names the channel — route matching, middleware execution,
 * response generation. ream had one channel (`ream:health`) and nothing for
 * HTTP, so there was no way to see why a request took the route it did short
 * of adding print statements.
 *
 * These are NOT request logs. Neither framework prints one by default; a
 * production request log belongs to `ctx.logger`, which is correlation-scoped.
 */
describe('debug channels', () => {
  it('are silent unless NODE_DEBUG names them', () => {
    // The suite does not set NODE_DEBUG, so both are off — which is the state
    // that matters: an inactive channel must not write to stderr.
    expect(debugHttp.enabled).toBe(false)
    expect(debugCore.enabled).toBe(false)
  })

  it('are callable when off, so a probe needs no guard to be safe', () => {
    expect(() => debugHttp('%s %s', 'GET', '/health')).not.toThrow()
    expect(() => debugCore('booted %d providers', 3)).not.toThrow()
  })

  it('expose `enabled`, which is what a hot-path probe guards on', () => {
    // The guard matters where building the ARGUMENTS costs something — the
    // per-request probes read the status and the correlation id.
    expect(typeof debugHttp.enabled).toBe('boolean')
    expect(typeof debugCore.enabled).toBe('boolean')
  })
})
