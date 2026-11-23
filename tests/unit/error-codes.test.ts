/**
 * Every refusal carries a stable `code`, so a caller branches on it instead of
 * on the wording. Each test below triggers the real refusal; the codes already
 * asserted next to the feature they guard are not repeated here.
 */

import 'reflect-metadata'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCodemods } from '../../src/Codemods.js'
import { GraphQLEngine } from '../../src/graphql/GraphQLEngine.js'
import { base64 } from '../../src/helpers/base64.js'
import { Response } from '../../src/http/Response.js'
import { openSseStream, type StreamBackend } from '../../src/http/SseStream.js'
import {
  Application,
  Container,
  createHttpKernel,
  errors,
  Ignitor,
  inject,
  MiddlewareRegistry,
  Router,
  Service,
} from '../../src/index.js'
import { DatabaseDriver } from '../../src/session/drivers/DatabaseDriver.js'
import { FileDriver } from '../../src/session/drivers/FileDriver.js'
import SessionMiddleware from '../../src/session/SessionMiddleware.js'
import { type HttpSender, RequestBuilder } from '../../src/testing/RequestBuilder.js'
import { TestClient } from '../../src/testing/TestClient.js'

const QUASAR = '@c9up/quasar/services/main'

afterEach(() => {
  vi.doUnmock(QUASAR)
  vi.resetModules()
})

describe('error codes > container', () => {
  it('refuses a contextual binding with no asksFor()', () => {
    class Consumer {}
    const container = new Container()
    expect(() => container.when(Consumer).provide(() => 'x')).toThrow(
      expect.objectContaining({ code: 'E_CONTAINER_MISSING_ASKS_FOR' }),
    )
  })

  it('refuses to call a member that is not a method', async () => {
    class Holder {
      readonly label = 'not callable'
    }
    await expect(new Container().call(new Holder(), 'label')).rejects.toMatchObject({
      code: 'E_CONTAINER_METHOD_NOT_CALLABLE',
    })
  })

  it('refuses @Service() and @inject() on something that is not a class', () => {
    // An arrow function has no prototype: nothing can construct it.
    expect(() => Service()(() => undefined)).toThrow(
      expect.objectContaining({ code: 'E_CONTAINER_INVALID_DECORATOR_TARGET' }),
    )
    expect(() => inject()(() => undefined)).toThrow(
      expect.objectContaining({ code: 'E_CONTAINER_INVALID_DECORATOR_TARGET' }),
    )
  })
})

describe('error codes > router and kernel', () => {
  it('refuses a resource with no name', () => {
    class PostsController {}
    expect(() => new Router().resource('/', PostsController)).toThrow(
      expect.objectContaining({ code: 'E_INVALID_RESOURCE_NAME' }),
    )
  })

  it('reports a controller that lacks the routed method', async () => {
    class UsersController {
      async index(): Promise<void> {}
    }
    const router = new Router()
    router.get('/users', [UsersController, 'missing'])
    const errors: unknown[] = []
    const kernel = createHttpKernel({
      router,
      middleware: new MiddlewareRegistry(),
      container: new Container(),
      onError: (error) => errors.push(error),
    })

    const response = await kernel({
      method: 'GET',
      path: '/users',
      query: '',
      headers: {},
      body: '',
    })

    expect(response.status).toBe(500)
    expect(errors[0]).toMatchObject({ code: 'E_CONTROLLER_METHOD_NOT_FOUND' })
  })

  it('answers an unmatched request with the upstream E_ROUTE_NOT_FOUND', async () => {
    const kernel = createHttpKernel({
      router: new Router(),
      middleware: new MiddlewareRegistry(),
      container: new Container(),
    })
    const response = await kernel({
      method: 'GET',
      path: '/missing',
      query: 'q=1',
      headers: { accept: 'application/json' },
      body: '',
    })
    expect(response.status).toBe(404)
    expect(JSON.parse(response.body)).toEqual({
      error: { code: 'E_ROUTE_NOT_FOUND', message: 'Cannot GET:/missing' },
    })
  })
})

describe('error codes > response', () => {
  it('refuses redirect() on a response built outside a request', () => {
    expect(() => new Response().redirect('/login')).toThrow(
      expect.objectContaining({ code: 'E_RESPONSE_NO_CONTEXT' }),
    )
  })

  it('refuses sse() on a server with no stream backend', async () => {
    await expect(new Response().sse()).rejects.toMatchObject({
      code: 'E_RESPONSE_SSE_UNSUPPORTED',
    })
  })

  it('refuses a stream the server would not register', async () => {
    const backend: StreamBackend = {
      registerStream: async () => false,
      writeStream: async () => true,
      closeStream: async () => true,
      onStreamDisconnect: () => {},
    }
    await expect(openSseStream(backend)).rejects.toMatchObject({ code: 'E_STREAM_REGISTER' })
  })
})

describe('error codes > test client', () => {
  // Every refusal below happens before anything is sent, so the answer is
  // never read.
  const sender: HttpSender = async () => ({
    status: 200,
    headers: {},
    body: '',
    json<T>(): T {
      throw new Error('the response body is not read here')
    },
  })

  it('refuses withCsrf() with no token to mirror', () => {
    expect(() => new RequestBuilder(sender, 'POST', '/p').withCsrf()).toThrow(
      expect.objectContaining({ code: 'E_TEST_CLIENT_MISSING_CSRF_TOKEN' }),
    )
  })

  it('refuses withAuth() without an auth strategy', async () => {
    await expect(
      new RequestBuilder(sender, 'GET', '/p').withAuth({ id: 1 }).send(),
    ).rejects.toMatchObject({
      code: 'E_TEST_CLIENT_NO_AUTH_STRATEGY',
    })
  })

  it('refuses a session guard login without a session seeder', async () => {
    const guard = { authenticateAsClient: async () => ({ session: { auth_id: 1 } }) }
    await expect(
      new RequestBuilder(sender, 'GET', '/p').loginAs(guard).send(),
    ).rejects.toMatchObject({
      code: 'E_TEST_CLIENT_NO_SESSION_SEEDER',
    })
  })

  it('refuses a serializer nobody registered', () => {
    expect(() =>
      new RequestBuilder(sender, 'POST', '/p').serialize('never-registered', {}),
    ).toThrow(expect.objectContaining({ code: 'E_TEST_CLIENT_UNKNOWN_SERIALIZER' }))
  })

  it('gives up on a server that never answers', async () => {
    // Accepts the connection, then says nothing.
    const silent = net.createServer(() => {})
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    const address = silent.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const client = new TestClient(async () => ({ port, close: () => {} }))
    try {
      await expect(client.get('/').timeout(50).send()).rejects.toMatchObject({
        code: 'E_TEST_CLIENT_TIMEOUT',
      })
    } finally {
      silent.close()
    }
  })
})

describe('error codes > sessions', () => {
  it('refuses a store whose required option is missing, or that does not exist', () => {
    expect(() => new SessionMiddleware({ store: 'cookie' })).toThrow(
      expect.objectContaining({ code: 'E_SESSION_MISSING_SECRET' }),
    )
    expect(() => new SessionMiddleware({ store: 'file' })).toThrow(
      expect.objectContaining({ code: 'E_SESSION_MISSING_LOCATION' }),
    )
    expect(() => new SessionMiddleware({ store: 'database' })).toThrow(
      expect.objectContaining({ code: 'E_SESSION_INVALID_CONNECTION' }),
    )
    expect(() => new SessionMiddleware({ store: 'carrier-pigeon' })).toThrow(
      expect.objectContaining({ code: 'E_SESSION_UNKNOWN_DRIVER' }),
    )
  })

  it('refuses a garbage-collection probability that is not a percentage', () => {
    const connection = { query: async () => [], execute: async () => ({ rowsAffected: 0 }) }
    expect(() => new DatabaseDriver({ connection, gcProbability: 101 })).toThrow(
      expect.objectContaining({ code: 'E_SESSION_INVALID_GC_PROBABILITY' }),
    )
  })

  it('gives up on a session file another request keeps locked', async () => {
    const location = fs.mkdtempSync(path.join(os.tmpdir(), 'ream-session-lock-'))
    try {
      const driver = new FileDriver({ location })
      await driver.write('sid', { a: 1 }, 60)
      // A fresh lock held by somebody else: not stale, so it is waited on.
      const [file] = fs.readdirSync(location)
      fs.mkdirSync(path.join(location, `${file}.lock`))
      await expect(driver.write('sid', { a: 2 }, 60)).rejects.toMatchObject({
        code: 'E_SESSION_FILE_LOCKED',
      })
    } finally {
      fs.rmSync(location, { recursive: true, force: true })
    }
  })

  it('names a missing quasar, and a connection that lacks what a session needs', async () => {
    vi.doMock(QUASAR, () => {
      throw new Error('Cannot find module')
    })
    const { quasarConnection } = await import('../../src/session/quasar.js')
    await expect(quasarConnection('main')()).rejects.toMatchObject({
      code: 'E_SESSION_QUASAR_MISSING',
    })

    vi.doUnmock(QUASAR)
    vi.resetModules()
    vi.doMock(QUASAR, () => ({
      connection: undefined,
      default: { connection: () => ({ get: () => null }) },
    }))
    const reloaded = await import('../../src/session/quasar.js')
    await expect(reloaded.quasarConnection('main')()).rejects.toMatchObject({
      code: 'E_SESSION_INCOMPLETE_CONNECTION',
    })
  })
})

describe('error codes > scheduler', () => {
  it('names a missing quasar, and a connection that lacks what a lock needs', async () => {
    vi.doMock(QUASAR, () => {
      throw new Error('Cannot find module')
    })
    const { quasarConnection } = await import('../../src/scheduler/locks/quasar.js')
    await expect(quasarConnection('main')()).rejects.toMatchObject({
      code: 'E_SCHEDULE_QUASAR_MISSING',
    })

    vi.doUnmock(QUASAR)
    vi.resetModules()
    vi.doMock(QUASAR, () => ({ connection: undefined, default: {} }))
    const reloaded = await import('../../src/scheduler/locks/quasar.js')
    await expect(reloaded.quasarConnection('main')()).rejects.toMatchObject({
      code: 'E_SCHEDULE_INCOMPLETE_CONNECTION',
    })
  })
})

describe('error codes > application', () => {
  it('collects every failing terminating hook under one code', async () => {
    const app = new Application()
    app.terminating(() => {
      throw new Error('first')
    })
    app.terminating(() => {
      throw new Error('second')
    })
    const failure = await app.terminate().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(errors.E_APP_SHUTDOWN_FAILED)
    expect(failure).toMatchObject({ code: 'E_APP_SHUTDOWN_FAILED' })
    const failures = failure instanceof errors.E_APP_SHUTDOWN_FAILED ? failure.errors : []
    // Terminating hooks run last-registered first.
    expect(failures.map((error) => (error instanceof Error ? error.message : ''))).toEqual([
      'second',
      'first',
    ])
  })

  it('refuses malformed base64 in strict mode', () => {
    expect(() => base64.decode('!!!', 'utf-8', true)).toThrow(
      expect.objectContaining({ code: 'E_BASE64_MALFORMED' }),
    )
    expect(() => base64.urlDecode('!!!', 'utf-8', true)).toThrow(
      expect.objectContaining({ code: 'E_BASE64_MALFORMED' }),
    )
  })

  it('refuses env validations that would break the file they are written into', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ream-env-validations-'))
    try {
      fs.mkdirSync(path.join(root, 'start'))
      fs.writeFileSync(
        path.join(root, 'start/env.ts'),
        "export default await Env.create(new URL('../', import.meta.url), {})\n",
      )
      const codemods = createCodemods({ cwd: root })
      await expect(
        codemods.defineEnvValidations({
          leadingComment: 'two\nlines',
          variables: { PORT: 'Env.schema.number()' },
        }),
      ).rejects.toMatchObject({ code: 'E_CODEMODS_INVALID_ENV_VALIDATION' })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  // What a hand-written or JavaScript rc file can hold: the type does not
  // reach it, so the boot has to name the entry.
  const bootWith = (rc: unknown) => {
    const ignitor = new Ignitor()
    Reflect.apply(ignitor.useRcFile, ignitor, [rc])
    return ignitor.start()
  }

  it('names an rc provider or preload entry that has no usable file', async () => {
    await expect(bootWith({ providers: [{ environment: ['web'] }] })).rejects.toMatchObject({
      code: 'E_MISSING_PROVIDER_FILE',
      message: `Invalid provider entry "{ environment: [ 'web' ] }". Missing file property`,
    })
    await expect(bootWith({ providers: [{ file: 'providers/app.ts' }] })).rejects.toMatchObject({
      code: 'E_INVALID_PROVIDER',
    })
    await expect(bootWith({ preloads: [{ environment: ['web'] }] })).rejects.toMatchObject({
      code: 'E_MISSING_PRELOAD_FILE',
    })
    await expect(bootWith({ preloads: [{ file: 'start/routes.ts' }] })).rejects.toMatchObject({
      code: 'E_INVALID_PRELOAD_FILE',
    })
  })

  it('refuses a provider module whose default export is missing or not a class', async () => {
    await expect(bootWith({ providers: [async () => ({})] })).rejects.toMatchObject({
      code: 'E_RUNTIME_EXCEPTION',
      message: expect.stringMatching(/It must have a default export$/),
    })
    await expect(
      bootWith({ providers: [async () => ({ default: () => ({}) })] }),
    ).rejects.toMatchObject({
      code: 'E_RUNTIME_EXCEPTION',
      message: expect.stringMatching(/is not a class$/),
    })
  })

  it('refuses a GraphQL schema file that does not exist', () => {
    expect(() => new GraphQLEngine({ schemaPath: '/nowhere/schema.graphql' })).toThrow(
      expect.objectContaining({ code: 'E_GRAPHQL_SCHEMA_NOT_FOUND' }),
    )
  })
})
