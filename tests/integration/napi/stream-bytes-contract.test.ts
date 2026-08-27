/**
 * The binary streaming path exists in the SHIPPED native binary.
 *
 * `response.stream()` only streams when the host exposes `writeStreamBytes`;
 * without it the code silently falls back to buffering the whole body. That
 * fallback is deliberate — a mock host in a unit test has no backend — but it
 * means a missing native method turns the streaming fix into a no-op that no
 * unit test can see. This asserts against the real `.node` file: it caught
 * exactly that, a binary built before the Rust method existed.
 */
import { createRequire } from 'node:module'
import { arch, platform } from 'node:process'
import { describe, expect, it } from 'vitest'

const SUFFIX: Record<string, string> = {
  'linux-x64': 'linux-x64-gnu',
  'linux-arm64': 'linux-arm64-gnu',
  'darwin-x64': 'darwin-x64',
  'darwin-arm64': 'darwin-arm64',
  'win32-x64': 'win32-x64-msvc',
}

const suffix = SUFFIX[`${platform}-${arch}`]
const require_ = createRequire(import.meta.url)

function loadNative(): { HyperServer?: { prototype: object } } | null {
  if (!suffix) return null
  try {
    return require_(`../../../index.${suffix}.node`)
  } catch {
    // Not built in this checkout (a fresh clone before `pnpm build:napi`).
    return null
  }
}

const native = loadNative()
const describeNative = native?.HyperServer ? describe : describe.skip

describeNative('HyperServer streaming contract', () => {
  function methods(): string[] {
    const proto = native?.HyperServer?.prototype
    return proto ? Object.getOwnPropertyNames(proto) : []
  }

  it('exposes the whole streaming surface the TS side expects', () => {
    // Each name is one the StreamBackend interface calls. A rename on the Rust
    // side is invisible to TypeScript — the backend is typed structurally and
    // handed over as an opaque host.
    for (const name of ['registerStream', 'writeStream', 'closeStream', 'onStreamDisconnect']) {
      expect(methods()).toContain(name)
    }
  })

  it('exposes writeStreamBytes, without which downloads silently buffer', () => {
    expect(methods()).toContain('writeStreamBytes')
  })

  it('round-trips a binary chunk through the real registry', async () => {
    // Existence is not enough: the method has to accept bytes and answer. A
    // server with no listener still owns a stream registry, which is what
    // register / write / close talk to.
    const HyperServer = native?.HyperServer as unknown as new (
      ...args: never[]
    ) => {
      registerStream(id: string): Promise<boolean>
      writeStreamBytes(id: string, chunk: Uint8Array): Promise<boolean>
      closeStream(id: string): Promise<boolean>
    }
    const server = new HyperServer()

    expect(await server.registerStream('contract-test')).toBe(true)
    // Bytes no UTF-8 decoder would survive — the reason this method exists.
    const accepted = await server.writeStreamBytes(
      'contract-test',
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x80]),
    )
    expect(typeof accepted).toBe('boolean')
    await server.closeStream('contract-test')
  })

  it('answers false for a stream nobody registered', async () => {
    const HyperServer = native?.HyperServer as unknown as new (
      ...args: never[]
    ) => { writeStreamBytes(id: string, chunk: Uint8Array): Promise<boolean> }
    const server = new HyperServer()

    // This is the signal `response.stream()` reads to stop pumping a file into
    // a socket nobody is on.
    expect(await server.writeStreamBytes('never-registered', new Uint8Array([1]))).toBe(false)
  })
})
