import { describe, expect, it } from 'vitest'
import { HttpContext } from '../../src/http/HttpContext.js'
import type { RawRequest } from '../../src/http/Request.js'
import { MiddlewareRegistry } from '../../src/index.js'

function makeCtx(): HttpContext {
  const raw: RawRequest = { method: 'GET', path: '/', query: '', headers: {}, body: '' }
  return new HttpContext('t', raw, {}, { pattern: '/', middleware: [] })
}

const noop = async () => {}

describe('route guard reads roles/permissions nested under ctx.auth.user', () => {
  it('allows when the role is nested under user (the warden shape)', async () => {
    const reg = new MiddlewareRegistry()
    let ran = false
    const chain = reg.buildChain([], [], async () => {
      ran = true
    }, { roles: ['admin'] })

    const ctx = makeCtx()
    // warden sets `ctx.auth = { authenticated, user: { roles } }` — NOT top-level.
    ctx.auth = { authenticated: true, user: { id: 'u1', roles: ['admin'] } }
    await chain(ctx, noop)
    expect(ran).toBe(true)
  })

  it('allows when permissions are nested under user', async () => {
    const reg = new MiddlewareRegistry()
    let ran = false
    const chain = reg.buildChain([], [], async () => {
      ran = true
    }, { permissions: ['tasks:write'] })

    const ctx = makeCtx()
    ctx.auth = { authenticated: true, user: { id: 'u1', permissions: ['tasks:write'] } }
    await chain(ctx, noop)
    expect(ran).toBe(true)
  })

  it('still reads top-level roles (provider that sets ctx.auth.roles directly)', async () => {
    const reg = new MiddlewareRegistry()
    let ran = false
    const chain = reg.buildChain([], [], async () => {
      ran = true
    }, { roles: ['admin'] })

    const ctx = makeCtx()
    ctx.auth = { authenticated: true, roles: ['admin'] }
    await chain(ctx, noop)
    expect(ran).toBe(true)
  })

  it('still denies (403) when the role is absent in both locations', async () => {
    const reg = new MiddlewareRegistry()
    const chain = reg.buildChain([], [], noop, { roles: ['admin'] })

    const ctx = makeCtx()
    ctx.auth = { authenticated: true, user: { id: 'u1', roles: ['member'] } }
    await expect(chain(ctx, noop)).rejects.toThrow()
  })
})
