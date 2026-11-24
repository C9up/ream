/**
 * A resolver's values live as long as the resolution it started, not as long
 * as the async resources that resolution created.
 *
 * `AsyncLocalStorage` hands its store to every timer or promise created while
 * it is active. A singleton built during one request whose constructor starts
 * background work kept that request's resolution chain: the work's later
 * `make(HttpContext)` received that request's context after it had ended.
 */
import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import BodyParserMiddleware from '../../src/bodyparser/BodyParserMiddleware.js'
import { createHyperServerFactory } from '../../src/bootstrap/hyper-server.js'
import { Container } from '../../src/container/Container.js'
import { Inject, Service } from '../../src/decorators/Service.js'
import { HttpContext } from '../../src/http/HttpContext.js'
import { Ignitor } from '../../src/index.js'

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('container > scoped values after the resolution settles', () => {
  it('a timer started while building reads no scoped value once the build is done', async () => {
    const container = new Container()
    const late: Promise<unknown>[] = []
    class Outbox {
      constructor() {
        setTimeout(() => {
          late.push(container.make('ctx').catch((error: unknown) => error))
        }, 5)
      }
    }
    container.singleton(Outbox, () => new Outbox())

    const resolver = container.createResolver()
    resolver.bindValue('ctx', { user: 'alice' })
    await resolver.make(Outbox)
    await tick(20)

    expect(late).toHaveLength(1)
    await expect(late[0]).resolves.toMatchObject({ code: 'E_CONTAINER_NOT_FOUND' })
  })

  it('still hands the value to everything the resolution builds, awaited or not yet', async () => {
    const container = new Container()
    class Repository {
      constructor(readonly ctx: unknown) {}
    }
    container.bind(Repository, async (c) => new Repository(await c.make('ctx')))
    const resolver = container.createResolver()
    resolver.bindValue('ctx', { user: 'alice' })

    const repository = await resolver.make<Repository>(Repository)

    expect(repository.ctx).toEqual({ user: 'alice' })
  })

  it('does not see a finished resolution as a cycle', async () => {
    const container = new Container()
    const late: Promise<unknown>[] = []
    class Clock {
      constructor() {
        setTimeout(() => {
          late.push(container.make(Clock))
        }, 5)
      }
    }
    container.singleton(Clock, () => new Clock())

    const clock = await container.make(Clock)
    await tick(20)

    await expect(late[0]).resolves.toBe(clock)
  })
})

@Service({ scope: 'transient' })
class Auditor {
  constructor(@Inject(HttpContext) readonly ctx: HttpContext) {}
  describe(): string {
    return `${this.ctx.request.header('x-user')} ${JSON.stringify(this.ctx.request.all())}`
  }
}

async function backgroundSees(buildAtBoot: boolean): Promise<string[]> {
  const seen: string[] = []
  let container: Container | undefined

  @Service()
  class Outbox {
    readonly timer: NodeJS.Timeout
    constructor() {
      this.timer = setInterval(async () => {
        if (container === undefined) return
        seen.push(
          await container.make<Auditor>(Auditor).then(
            (auditor) => auditor.describe(),
            () => 'no request',
          ),
        )
      }, 15)
    }
  }
  class NotesController {
    constructor(@Inject(Outbox) readonly outbox: Outbox) {}
    async store({ response }: HttpContext): Promise<void> {
      response.json({ ok: true })
    }
  }

  const bodyParser = new BodyParserMiddleware()
  const ignitor = await new Ignitor({
    port: 0,
    gracefulShutdown: false,
    serverFactory: createHyperServerFactory(),
  })
    .use((ctx, next) => bodyParser.handle(ctx, next))
    .routes((router) => router.post('/notes', [NotesController, 'store']))
    .httpServer()
    .start()
  const app = ignitor.getApp().container
  container = app
  if (buildAtBoot) await app.make(Outbox)
  const port = await ignitor.port()
  const post = (user: string, note: string) =>
    fetch(`http://127.0.0.1:${port}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user': user },
      body: JSON.stringify({ note }),
    }).then((res) => res.status)

  try {
    expect(await post('alice', 'alice private note')).toBe(200)
    seen.length = 0
    expect(await post('bob', 'bob private note')).toBe(200)
    await tick(80)
  } finally {
    clearInterval((await app.make<Outbox>(Outbox)).timer)
    await ignitor.stop()
  }
  return [...new Set(seen)]
}

describe('container > a singleton built during a request, over HTTP', () => {
  it("never hands that request's HttpContext to its background work", async () => {
    expect(await backgroundSees(false)).toEqual(['no request'])
    expect(await backgroundSees(true)).toEqual(['no request'])
  })
})
