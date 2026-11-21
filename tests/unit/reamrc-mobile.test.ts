import { describe, expect, it } from 'vitest'
import { defineConfig, type MobileConfig } from '../../src/Ignitor.js'

/**
 * `mobile` is read by ream-cli (`ream android:*`), which checks every value;
 * defineConfig types it so an app's rc file is checked as it is written.
 * The test is the type check (`tsc -p .` covers tests) and the pass-through.
 */
describe('defineConfig > mobile', () => {
  it('accepts the block ream-cli reads, and hands it on as written', () => {
    const mobile: MobileConfig = {
      name: 'Tessel',
      id: 'ch.c9up.tessel',
      entry: 'mobile/index.ts',
      version: '1.2.0',
      build: 12,
      css: 'mobile/app.css',
      android: {
        permissions: ['CAMERA'],
        abis: ['arm64-v8a'],
        signing: { keystore: 'android/release.keystore', alias: 'release' },
      },
      updates: { url: 'https://api.example/__robledo', publicKey: 'key' },
    }
    expect(defineConfig({ mobile }).mobile).toBe(mobile)
  })

  it('refuses at compile time what the CLI would refuse at build time', () => {
    // @ts-expect-error an ABI Android does not build for
    const abis: NonNullable<MobileConfig['android']>['abis'] = ['mips']
    // @ts-expect-error `id` and `entry` are required
    const partial: MobileConfig = { name: 'App' }
    expect([abis, partial]).toHaveLength(2)
  })
})
