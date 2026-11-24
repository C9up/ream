/**
 * Ream's route gate enforces the four decorators of the auth package on a
 * controller action: `@Guard`, `@Role`, `@Permission` and `@RequireMfa`. The
 * fourth used to be dropped: on a stack that fills `ctx.auth` and relies on
 * this gate, an action declared `@RequireMfa()` ran without the step-up.
 *
 * The decorators below write the metadata keys `@c9up/warden` writes; ream
 * reads them without importing it.
 */
import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import type { AuthState, HttpContext } from '../../src/http/HttpContext.js'
import {
  Container,
  createHttpKernel,
  type MiddlewareFunction,
  MiddlewareRegistry,
  Router,
} from '../../src/index.js'

const meta = (key: string, value: unknown): MethodDecorator => {
  return (target, propertyKey) => {
    Reflect.defineMetadata(Symbol.for(key), value, target, propertyKey)
  }
}
const Guard = (...guards: string[]) => meta('warden:guard', guards)
const Role = (...roles: string[]) => meta('warden:role', roles)
const Permission = (...permissions: string[]) => meta('warden:permission', permissions)
const RequireMfa = () => meta('warden:mfa', true)

let ran: string[] = []
const run = (name: string) => (ctx: HttpContext) => {
  ran.push(name)
  ctx.response.send(name)
}

class TransferController {
  @Guard('jwt')
  @RequireMfa()
  async transfer(ctx: HttpContext): Promise<void> {
    run('transfer')(ctx)
  }

  // Alone, it still requires an authenticated request.
  @RequireMfa()
  async rotateKeys(ctx: HttpContext): Promise<void> {
    run('rotateKeys')(ctx)
  }

  @Role('admin')
  @Permission('funds.move')
  @RequireMfa()
  async wire(ctx: HttpContext): Promise<void> {
    run('wire')(ctx)
  }

  async balance(ctx: HttpContext): Promise<void> {
    run('balance')(ctx)
  }
}

/** Inherits `transfer` and `rotateKeys`; overrides `balance` with a decorator of its own. */
class PremiumTransferController extends TransferController {
  @RequireMfa()
  override async balance(ctx: HttpContext): Promise<void> {
    run('premium balance')(ctx)
  }
}

interface Identity {
  via?: string
  roles?: string[]
  permissions?: string[]
  /** The `mfa` claim of the credential, as the guard would set it. */
  mfa?: unknown
}

function authFor(identity: Identity | undefined): AuthState {
  if (identity === undefined) return { isAuthenticated: false }
  return {
    isAuthenticated: true,
    authenticatedViaGuard: identity.via ?? 'jwt',
    user: {
      id: 'u1',
      roles: identity.roles ?? [],
      permissions: identity.permissions ?? [],
      ...(identity.mfa === undefined ? {} : { mfa: identity.mfa }),
    },
  }
}

function app(declare: (router: Router) => void) {
  const router = new Router()
  declare(router)
  return async (path: string, identity?: Identity) => {
    ran = []
    const populate: MiddlewareFunction = async (ctx, next) => {
      ctx.auth = authFor(identity)
      await next()
    }
    const kernel = createHttpKernel({
      router,
      container: new Container(),
      middleware: new MiddlewareRegistry(),
      serverMiddleware: [populate],
    })
    const response = await kernel({
      method: 'GET',
      path,
      query: '',
      headers: { accept: 'application/json' },
      body: '',
    })
    return { status: response.status, body: response.body, ran: [...ran] }
  }
}

const MFA_REQUIRED = {
  error: {
    code: 'E_WARDEN_MFA_REQUIRED',
    message: 'Multi-factor authentication is required for this action.',
  },
}

const direct = (router: Router): void => {
  router.get('/transfer', [TransferController, 'transfer'])
  router.get('/keys/rotate', [TransferController, 'rotateKeys'])
  router.get('/wire', [TransferController, 'wire'])
  router.get('/balance', [TransferController, 'balance'])
}

describe('route gate > @RequireMfa', () => {
  it('refuses a credential without the step-up with the body the auth middleware writes', async () => {
    const request = app(direct)
    // Signed in with the password only: no `mfa` claim.
    const refused = await request('/transfer', {})
    expect(refused.status).toBe(403)
    expect(JSON.parse(refused.body)).toEqual(MFA_REQUIRED)
    expect(refused.ran).toEqual([])
    // ...every time, not only the first.
    expect((await request('/transfer', {})).status).toBe(403)
  })

  it('runs the action once the credential completed the step-up', async () => {
    const request = app(direct)
    const passed = await request('/transfer', { mfa: true })
    expect([passed.status, passed.ran]).toEqual([200, ['transfer']])
  })

  it('takes nothing but `mfa: true` for a completed step-up', async () => {
    const request = app(direct)
    for (const mfa of [false, 'true', 1, 'yes', {}, null]) {
      const response = await request('/transfer', { mfa })
      expect([mfa, response.status, response.ran]).toEqual([mfa, 403, []])
    }
  })

  it('requires an authenticated request when it stands alone', async () => {
    const request = app(direct)
    const anonymous = await request('/keys/rotate')
    expect(anonymous.status).toBe(401)
    expect(JSON.parse(anonymous.body).error.code).toBe('E_UNAUTHORIZED_ACCESS')
    expect(anonymous.ran).toEqual([])
    expect((await request('/keys/rotate', {})).status).toBe(403)
    expect((await request('/keys/rotate', { mfa: true })).ran).toEqual(['rotateKeys'])
  })

  it('still answers 401 first to an anonymous request on a guarded action', async () => {
    const request = app(direct)
    expect((await request('/transfer')).status).toBe(401)
    // Authenticated by another guard than the one the action names.
    expect((await request('/transfer', { via: 'web', mfa: true })).status).toBe(401)
  })

  it('checks roles and permissions before the step-up, as the auth middleware does', async () => {
    const request = app(direct)
    const noRole = await request('/wire', { mfa: true, permissions: ['funds.move'] })
    expect(noRole.status).toBe(403)
    expect(JSON.parse(noRole.body)).toEqual({ errors: [{ message: 'Access denied' }] })
    const noStepUp = await request('/wire', { roles: ['admin'], permissions: ['funds.move'] })
    expect(JSON.parse(noStepUp.body)).toEqual(MFA_REQUIRED)
    const all = await request('/wire', {
      roles: ['admin'],
      permissions: ['funds.move'],
      mfa: true,
    })
    expect(all.ran).toEqual(['wire'])
  })

  it('leaves an action without the decorator alone', async () => {
    const request = app(direct)
    expect((await request('/balance')).ran).toEqual(['balance'])
  })

  it('reads the decorator an action inherits, and one an override adds', async () => {
    const request = app((router) => {
      router.get('/transfer', [PremiumTransferController, 'transfer'])
      router.get('/keys/rotate', [PremiumTransferController, 'rotateKeys'])
      router.get('/balance', [PremiumTransferController, 'balance'])
    })
    expect((await request('/transfer', {})).status).toBe(403)
    expect((await request('/keys/rotate')).status).toBe(401)
    expect((await request('/balance', {})).status).toBe(403)
    expect((await request('/balance', { mfa: true })).ran).toEqual(['premium balance'])
  })

  it('holds on the first request to a lazily imported controller', async () => {
    const lazy = async () => ({ default: TransferController })
    const request = app((router) => {
      router.get('/transfer', [lazy, 'transfer'])
      router.get('/keys/rotate', [lazy, 'rotateKeys'])
    })
    const first = await request('/transfer', {})
    expect([first.status, first.ran]).toEqual([403, []])
    const anonymous = await request('/keys/rotate')
    expect([anonymous.status, anonymous.ran]).toEqual([401, []])
  })

  it('applies on top of the gates the route declares itself', async () => {
    const request = app((router) => {
      router.get('/transfer', [TransferController, 'rotateKeys']).guard('jwt').role('teller')
    })
    expect((await request('/transfer', { roles: ['teller'] })).status).toBe(403)
    expect((await request('/transfer', { mfa: true })).status).toBe(403)
    expect((await request('/transfer', { roles: ['teller'], mfa: true })).ran).toEqual([
      'rotateKeys',
    ])
  })
})
