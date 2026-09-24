import { afterEach, describe, expect, it } from 'vitest'
import { inDevServer, readyBannerLines } from '../../src/dev/readyBanner.js'

/**
 * The sticker printed once the dev server is listening.
 *
 * Upstream prints the address, the mode and the boot time the moment the
 * child reports ready. Without it, `ream dev` said nothing at all: the server
 * was up and you had to guess which port it found.
 */
describe('dev > the ready banner', () => {
  const previous = process.env.REAM_DEV
  const plain = (line: string) => line.replace(/\u001B\[\d+m/g, '')

  afterEach(() => {
    if (previous === undefined) delete process.env.REAM_DEV
    else process.env.REAM_DEV = previous
  })

  it('says the address, the mode and how long the boot took', () => {
    const lines = readyBannerLines({
      host: 'localhost',
      port: 3333,
      mode: 'HMR',
      bootMs: 412,
    }).map(plain)

    expect(lines).toEqual([
      'Server address: http://localhost:3333',
      'Mode: HMR',
      'Ready in: 412 ms',
    ])
  })

  it('shows a link that opens, not the address that was bound', () => {
    // `0.0.0.0` means every interface. Printed as a URL it is a link that
    // goes nowhere, and you go looking in the wrong place.
    const [address] = readyBannerLines({ host: '0.0.0.0', port: 3000, mode: 'HMR' }).map(plain)
    expect(address).toBe('Server address: http://localhost:3000')
  })

  it('leaves the boot time out when nobody measured it', () => {
    const lines = readyBannerLines({ host: 'localhost', port: 3000, mode: 'HMR' })
    expect(lines).toHaveLength(2)
  })

  it('reads a slow boot in seconds', () => {
    const lines = readyBannerLines({
      host: 'localhost',
      port: 3000,
      mode: 'HMR',
      bootMs: 1240,
    }).map(plain)
    expect(lines[2]).toBe('Ready in: 1.2 s')
  })

  it('colours the value and not the label', () => {
    // Upstream colours the address, the mode and the duration — cyan, on a
    // plain label. A line where everything is coloured reads as one blob.
    const [address] = readyBannerLines({
      host: 'localhost',
      port: 3000,
      mode: 'HMR',
    })
    expect(address?.startsWith('Server address: ')).toBe(true)
  })

  it('prints only under `ream dev`', () => {
    // A production boot must not draw a box round its own address, and a test
    // run must not print one per case.
    delete process.env.REAM_DEV
    expect(inDevServer()).toBe(false)
    process.env.REAM_DEV = 'true'
    expect(inDevServer()).toBe(true)
  })
})
