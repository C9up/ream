/**
 * `@inject()` on a method — `@adonisjs/fold`'s method injection: a controller
 * action, a command's `run()` or a listener's `handle()` takes a service by
 * type without widening the constructor.
 */

import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { Container } from '../../src/container/Container.js'
import { getServiceMetadata, Inject, inject } from '../../src/decorators/Service.js'

class HttpCtx {
  constructor(readonly id: string) {}
}
class UserService {
  all(): string[] {
    return ['ada']
  }
}

/** Apply `@inject()` to a method the way TypeScript does, metadata included. */
function decorateMethod(target: object, method: string, paramTypes: unknown[]): void {
  // What tsc emits for a decorated method (vitest's transform does not).
  Reflect.defineMetadata('design:paramtypes', paramTypes, target, method)
  const descriptor = Object.getOwnPropertyDescriptor(target, method)
  inject()(target, method, descriptor ?? {})
}

describe('@inject() on a method', () => {
  it('is accepted on a method and does not register the class as a service', () => {
    class Ctrl {
      store(): void {}
    }
    const descriptor = Object.getOwnPropertyDescriptor(Ctrl.prototype, 'store') ?? {}
    expect(() => inject()(Ctrl.prototype, 'store', descriptor)).not.toThrow()
    expect(getServiceMetadata(Ctrl)).toBeUndefined()
  })

  it('resolves every non-runtime parameter by type, after the runtime values', async () => {
    class UsersController {
      async index(ctx: HttpCtx, users: UserService): Promise<{ id: string; all: string[] }> {
        return { id: ctx.id, all: users.all() }
      }
    }
    decorateMethod(UsersController.prototype, 'index', [HttpCtx, UserService])
    // The record is what `call()` reads, not the transient reflection.
    Reflect.deleteMetadata('design:paramtypes', UsersController.prototype, 'index')

    const result = await new Container().call(new UsersController(), 'index', [new HttpCtx('r1')])
    expect(result).toEqual({ id: 'r1', all: ['ada'] })
  })

  it("honours fold's hand-written static containerInjections for a method", async () => {
    class Listener {
      static containerInjections = { handle: { dependencies: [String, UserService] } }
      handle(event: string, users: UserService): string {
        return `${event}:${users.all().length}`
      }
    }
    expect(await new Container().call(new Listener(), 'handle', ['created'])).toBe('created:1')
  })

  it('lets @Inject(token) on one parameter override its type', async () => {
    class Ctrl {
      show(ctx: HttpCtx, users: { all(): string[] }): string[] {
        void ctx
        return users.all()
      }
    }
    decorateMethod(Ctrl.prototype, 'show', [HttpCtx, Object])
    Inject('users')(Ctrl.prototype, 'show', 1)
    const container = new Container()
    container.bind('users', () => ({ all: () => ['named'] }))
    expect(await container.call(new Ctrl(), 'show', [new HttpCtx('r2')])).toEqual(['named'])
  })

  it('keeps the class form: transient service with constructor injection', () => {
    @inject()
    class Ctrl {}
    expect(getServiceMetadata(Ctrl)?.scope).toBe('transient')
  })
})
