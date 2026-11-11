import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import type { HttpKernelRequest, HttpKernelResponse } from '../../src/HttpKernel.js'
import type { HyperServerLike } from '../../src/index.js'
import { Ignitor, Provider } from '../../src/index.js'
import {
  type NativeBodyLimits,
  type NativeConnectionConfig,
  nativeBodyLimits,
  nativeConnectionConfig,
} from '../../src/server/nativeLimits.js'

class RecordingServer implements HyperServerLike {
  bodyLimits?: NativeBodyLimits
  connections?: NativeConnectionConfig
  onRequest(_callback: (request: HttpKernelRequest) => Promise<HttpKernelResponse>): void {}
  configureBodyLimits(config: NativeBodyLimits): void {
    this.bodyLimits = config
  }
  configureConnections(config: NativeConnectionConfig): void {
    this.connections = config
  }
  async listen(): Promise<void> {}
  async port(): Promise<number> {
    return 0
  }
  async close(): Promise<void> {}
}

describe('native limits > config translation', () => {
  it('turns body-parser sizes into bytes and keeps the declared types', () => {
    expect(
      nativeBodyLimits({
        json: { limit: '2mb' },
        multipart: { limit: '50mb', types: ['multipart/form-data'] },
        form: { types: [] },
      }),
    ).toEqual({
      json: { limit: 2 * 1024 * 1024 },
      multipart: { limit: 50 * 1024 * 1024, types: ['multipart/form-data'] },
      form: { types: [] },
    })
  })

  it('hands the multipart part counts to the native parser', () => {
    expect(nativeBodyLimits({ multipart: { maxFields: 50, maxFiles: 5 } })).toEqual({
      multipart: { maxFields: 50, maxFiles: 5 },
    })
  })

  it('picks the timeouts and the connection cap out of the http block', () => {
    expect(
      nativeConnectionConfig({
        headersTimeout: 10_000,
        keepAliveTimeout: 0,
        maxConnections: 500,
        allowMethodSpoofing: true,
      }),
    ).toEqual({ headersTimeout: 10_000, keepAliveTimeout: 0, maxConnections: 500 })
    expect(nativeConnectionConfig(undefined)).toEqual({})
  })

  it('refuses a timeout the native server cannot hold', () => {
    for (const value of [-1, 1.5, '5000', 2 ** 32]) {
      expect(() => nativeConnectionConfig({ requestTimeout: value })).toThrow(
        /E_IGNITOR_INVALID_HTTP_CONFIG|requestTimeout/,
      )
    }
  })
})

describe('native limits > Ignitor wiring', () => {
  it('hands config/bodyparser and app.http to the native server before it listens', async () => {
    let server: RecordingServer | undefined
    class Config extends Provider {
      override register() {
        this.app.config.set('bodyparser', { json: { limit: '5mb' } })
        this.app.config.set('app.http', { headersTimeout: 20_000, requestTimeout: 60_000 })
      }
    }
    const ignitor = await new Ignitor({
      port: 0,
      gracefulShutdown: false,
      serverFactory: () => {
        server = new RecordingServer()
        return server
      },
    })
      .httpServer()
      .provider((app) => new Config(app))
      .start()
    expect(server?.bodyLimits).toEqual({ json: { limit: 5 * 1024 * 1024 } })
    expect(server?.connections).toEqual({ headersTimeout: 20_000, requestTimeout: 60_000 })
    await ignitor.stop()
  })
})
