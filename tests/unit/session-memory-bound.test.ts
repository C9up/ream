/**
 * The in-memory session store swept only EXPIRED entries, so within the TTL
 * window nothing bounded it: anyone able to request a page could mint sessions
 * until the process ran out of memory, without ever logging in.
 */
import { describe, expect, it } from 'vitest'
import { MemoryDriver } from '../../src/session/drivers/MemoryDriver.js'

describe('ream > session memory bound', () => {
  it('stops growing once the cap is reached', async () => {
    const driver = new MemoryDriver({ maxEntries: 50 })
    for (let i = 0; i < 500; i++) {
      await driver.write(`session-${i}`, { i }, 3600)
    }
    // The oldest are gone; the newest are kept.
    expect(await driver.read('session-0')).toEqual({})
    expect(await driver.read('session-499')).toEqual({ i: 499 })
  })

  it('an active session outlives the ones that went quiet', async () => {
    const driver = new MemoryDriver({ maxEntries: 10 })
    await driver.write('mine', { user: 1 }, 3600)
    // 30 other sessions arrive, but mine is written on every request — which
    // is what a session middleware does — so it must survive them all.
    for (let i = 0; i < 30; i++) {
      await driver.write(`other-${i}`, { i }, 3600)
      await driver.write('mine', { user: 1 }, 3600)
    }
    expect(await driver.read('mine')).toEqual({ user: 1 })
    // And the ones that went quiet were dropped.
    expect(await driver.read('other-0')).toEqual({})
  })

  it('still expires entries on read', async () => {
    const driver = new MemoryDriver()
    await driver.write('s', { a: 1 }, -1)
    expect(await driver.read('s')).toEqual({})
  })

  it('keeps everything below the cap', async () => {
    const driver = new MemoryDriver({ maxEntries: 100 })
    for (let i = 0; i < 100; i++) await driver.write(`s-${i}`, { i }, 3600)
    expect(await driver.read('s-0')).toEqual({ i: 0 })
    expect(await driver.read('s-99')).toEqual({ i: 99 })
  })
})
