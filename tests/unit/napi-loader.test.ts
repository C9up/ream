/**
 * Where ream finds its native binaries: the local build first, then the
 * platform package `@c9up/ream-<suffix>` that an install of ream carries.
 *
 * `require` is replaced by a stand-in that records every id asked for, so each
 * case runs on any host and never touches a real binary.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

const HOST = { platform: 'linux', arch: 'x64', suffix: 'linux-x64-gnu' }
const PLATFORM_PACKAGE = `@c9up/ream-${HOST.suffix}`

/** What `require` throws for a module that is not there. */
function notFound(id: string): Error {
  return Object.assign(new Error(`Cannot find module '${id}'`), { code: 'MODULE_NOT_FOUND' })
}

/** A module standing in for the `index` binary. */
class HyperServer {
  readonly port: number
  constructor(port: number) {
    this.port = port
  }
}

/** Load ream's loader with `require` running `load` for every id it asks for. */
async function withRequire(
  load: (id: string) => unknown,
  host: { platform: string; arch: string } = HOST,
) {
  vi.resetModules()
  vi.doMock('node:process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:process')>()),
    platform: host.platform,
    arch: host.arch,
  }))
  vi.doMock('node:module', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:module')>()),
    createRequire: () => load,
  }))
  const loader = await import('../../src/helpers/napi-loader.js')
  const server = await import('../../src/bootstrap/hyper-server.js')
  return { loader, server }
}

/** What `load` throws, or `undefined` when it returns. */
function thrownBy(load: () => unknown): unknown {
  try {
    load()
    return undefined
  } catch (error) {
    return error
  }
}

afterEach(() => {
  vi.doUnmock('node:process')
  vi.doUnmock('node:module')
  vi.resetModules()
})

describe('napi-loader > the local build, then the platform package', () => {
  it('prefers a local build, and never asks for the package then', async () => {
    const asked: string[] = []
    const binary = { EventBus: class {} }
    const { loader } = await withRequire((id) => {
      asked.push(id)
      return binary
    })

    const loaded = loader.loadNapi({ binaryName: 'events', callerMetaUrl: import.meta.url })

    expect(loaded).toBe(binary)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatch(/[\\/]events\.linux-x64-gnu\.node$/)
  })

  it('loads the binary from the platform package when no local build exists', async () => {
    const asked: string[] = []
    const binary = { RustScheduler: class {} }
    const { loader } = await withRequire((id) => {
      asked.push(id)
      if (id === `${PLATFORM_PACKAGE}/scheduler.linux-x64-gnu.node`) return binary
      throw notFound(id)
    })

    const loaded = loader.loadNapi({ binaryName: 'scheduler', callerMetaUrl: import.meta.url })

    expect(loaded).toBe(binary)
    // The three local paths, then the binary of that name inside the package.
    expect(asked).toHaveLength(4)
    expect(asked[3]).toBe(`${PLATFORM_PACKAGE}/scheduler.linux-x64-gnu.node`)
  })

  it('names the platform package to install when neither is there, with the load error as the cause', async () => {
    const { loader } = await withRequire((id) => {
      throw notFound(id)
    })

    const error = thrownBy(() =>
      loader.loadNapi({ binaryName: 'index', callerMetaUrl: import.meta.url }),
    )

    expect(error).toMatchObject({
      code: 'E_REAM_NAPI_NOT_FOUND',
      message: `index NAPI binary not found. Expected index.linux-x64-gnu.node at the package root or in ${PLATFORM_PACKAGE}`,
      cause: { code: 'MODULE_NOT_FOUND' },
    })
    expect(String(error)).not.toContain('Cannot find module')
    expect(error).toHaveProperty(
      'help',
      `Install ${PLATFORM_PACKAGE} at the exact version of @c9up/ream: it is the optional dependency that carries the linux-x64-gnu binaries, ` +
        'and an install that omits optional dependencies (--no-optional, --omit=optional) skips it. ' +
        'In a checkout of ream, build them instead: pnpm --filter @c9up/ream build:napi. ' +
        'If you are on Alpine/musl, note the prebuilt Linux binaries target glibc — musl is not a supported target.',
    )
  })

  it("puts the caller's own hint in place of the build command", async () => {
    const { loader } = await withRequire(
      (id) => {
        throw notFound(id)
      },
      { platform: 'darwin', arch: 'arm64' },
    )

    const error = thrownBy(() =>
      loader.loadNapi({
        binaryName: 'index',
        callerMetaUrl: import.meta.url,
        notFoundHint: 'Run the build.',
      }),
    )

    expect(error).toHaveProperty(
      'help',
      'Install @c9up/ream-darwin-arm64 at the exact version of @c9up/ream: it is the optional dependency that carries the darwin-arm64 binaries, ' +
        'and an install that omits optional dependencies (--no-optional, --omit=optional) skips it. Run the build.',
    )
  })

  it('reports a local build that fails to load, instead of falling back to the package', async () => {
    const asked: string[] = []
    const { loader } = await withRequire((id) => {
      asked.push(id)
      throw new Error(`${id}: invalid ELF header`)
    })

    const error = thrownBy(() =>
      loader.loadNapi({ binaryName: 'index', callerMetaUrl: import.meta.url }),
    )

    expect(asked).toHaveLength(1)
    expect(error).toMatchObject({
      code: 'E_REAM_NAPI_LOAD_FAILED',
      message:
        'The index NAPI binary (index.linux-x64-gnu.node, the local build) failed to load. ' +
        'Fix: rebuild it for this platform and Node version: pnpm --filter @c9up/ream build:napi.',
      cause: { message: `${asked[0]}: invalid ELF header` },
      help: expect.stringContaining('build:napi'),
    })
    // The host path and the load error's text stay in the cause.
    expect(String(error)).not.toContain(String(asked[0]))
    expect(String(error)).not.toContain('invalid ELF header')
  })

  it("puts the caller's own hint in the fix of a local build that fails to load", async () => {
    const { loader } = await withRequire(() => {
      throw new Error('invalid ELF header')
    })

    const error = thrownBy(() =>
      loader.loadNapi({
        binaryName: 'scheduler',
        callerMetaUrl: import.meta.url,
        notFoundHint: 'Run the build.',
      }),
    )

    expect(error).toHaveProperty(
      'message',
      'The scheduler NAPI binary (scheduler.linux-x64-gnu.node, the local build) failed to load. Fix: Run the build.',
    )
  })

  it('reports a platform package whose binary fails to load, naming it', async () => {
    const { loader } = await withRequire((id) => {
      if (id.startsWith(PLATFORM_PACKAGE)) throw new Error('wrong Node ABI')
      throw notFound(id)
    })

    const error = thrownBy(() =>
      loader.loadNapi({ binaryName: 'events', callerMetaUrl: import.meta.url }),
    )

    expect(error).toMatchObject({
      code: 'E_REAM_NAPI_LOAD_FAILED',
      message:
        `The events NAPI binary (${PLATFORM_PACKAGE}/events.linux-x64-gnu.node) failed to load. ` +
        `Fix: reinstall ${PLATFORM_PACKAGE} at the exact version of @c9up/ream, on the machine that runs the app ` +
        '(a node_modules copied from another platform or Node version carries the wrong binary). ' +
        'If you are on Alpine/musl, note the prebuilt Linux binaries target glibc — musl is not a supported target.',
      cause: { message: 'wrong Node ABI' },
    })
  })

  it('refuses a host no binary is built for, without asking for anything', async () => {
    const asked: string[] = []
    const { loader } = await withRequire(
      (id) => {
        asked.push(id)
        return {}
      },
      { platform: 'linux', arch: 'riscv64' },
    )

    const error = thrownBy(() =>
      loader.loadNapi({ binaryName: 'index', callerMetaUrl: import.meta.url }),
    )

    expect(asked).toHaveLength(0)
    expect(error).toMatchObject({ code: 'E_REAM_NAPI_UNSUPPORTED_PLATFORM' })
  })
})

describe('createHyperServerFactory > through the shared loader', () => {
  it('builds servers from the platform package when no local build exists', async () => {
    const { server } = await withRequire((id) => {
      if (id === `${PLATFORM_PACKAGE}/index.linux-x64-gnu.node`) return { HyperServer }
      throw notFound(id)
    })

    const factory = server.createHyperServerFactory()

    expect(factory(4321)).toMatchObject({ port: 4321 })
  })

  it('refuses with E_REAM_NAPI_NOT_FOUND, naming the platform package, when no binary is found anywhere', async () => {
    const { server } = await withRequire((id) => {
      throw notFound(id)
    })

    const error = thrownBy(() => server.createHyperServerFactory())

    expect(error).toMatchObject({
      code: 'E_REAM_NAPI_NOT_FOUND',
      cause: { code: 'MODULE_NOT_FOUND' },
    })
    expect(error).toHaveProperty('help', expect.stringContaining(`Install ${PLATFORM_PACKAGE}`))
  })

  it('surfaces a local build that fails to load as E_REAM_NAPI_LOAD_FAILED, keeping the cause', async () => {
    const loadError = new Error('invalid ELF header')
    const { server } = await withRequire(() => {
      throw loadError
    })

    const error = thrownBy(() => server.createHyperServerFactory())

    expect(error).toMatchObject({ code: 'E_REAM_NAPI_LOAD_FAILED' })
    expect(error).toHaveProperty('cause', loadError)
  })

  it('surfaces an installed platform package that fails to load as E_REAM_NAPI_LOAD_FAILED, keeping the cause', async () => {
    const loadError = new Error('wrong Node ABI')
    const { server } = await withRequire((id) => {
      if (id.startsWith(PLATFORM_PACKAGE)) throw loadError
      throw notFound(id)
    })

    const error = thrownBy(() => server.createHyperServerFactory())

    expect(error).toMatchObject({
      code: 'E_REAM_NAPI_LOAD_FAILED',
      message: expect.stringContaining(
        `The index NAPI binary (${PLATFORM_PACKAGE}/index.linux-x64-gnu.node) failed to load. Fix: reinstall ${PLATFORM_PACKAGE}`,
      ),
    })
    expect(error).toHaveProperty('cause', loadError)
  })

  it('refuses a host no binary is built for with E_REAM_NAPI_UNSUPPORTED_PLATFORM', async () => {
    const { server } = await withRequire(() => ({ HyperServer }), {
      platform: 'linux',
      arch: 'riscv64',
    })

    expect(thrownBy(() => server.createHyperServerFactory())).toMatchObject({
      code: 'E_REAM_NAPI_UNSUPPORTED_PLATFORM',
    })
  })

  it('refuses a binary that loads but is not the HTTP server with E_REAM_NAPI_LOAD_FAILED', async () => {
    const { server } = await withRequire(() => ({ EventBus: class {} }))

    expect(thrownBy(() => server.createHyperServerFactory())).toMatchObject({
      code: 'E_REAM_NAPI_LOAD_FAILED',
      message:
        'The index NAPI binary (index.<platform>.node) failed to load. Fix: it exports no HyperServer class, ' +
        'so it is not the HTTP server ream builds: rebuild it (pnpm --filter @c9up/ream build:napi) or reinstall @c9up/ream.',
    })
  })
})
